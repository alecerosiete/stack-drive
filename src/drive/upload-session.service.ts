import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { UploadSession } from '@prisma/client';
import { Readable } from 'node:stream';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import {
  GoogleApiException,
  UploadInterruptedException,
  UploadSessionExpiredException,
  UploadSessionNotFoundException,
} from '../common/errors';
import { normalizeGoogleError } from '../common/google-error.util';
import { withRetry } from '../common/retry';
import { DriveClientFactory, DriveContext } from '../google/drive-client.factory';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUploadSessionDto } from './dto/drive.dto';
import { FILE_FIELDS, toFileView } from './drive.types';
import {
  cancelSession,
  isResumable,
  querySession,
  SessionStatus,
  sendChunk,
  startSession,
} from './resumable-upload';
import { UploadSessionView } from './upload-session.types';

/** Google exige que todo bloque salvo el último sea múltiplo de 256 KiB. */
export const CHUNK_GRANULE = 256 * 1024;
/**
 * Lo que se pierde como mucho en un corte. Más grande ahorra peticiones; más
 * pequeño hace que una red mala avance igualmente. Nada se bufferiza, así que
 * no afecta a la memoria del servidor.
 */
export const CHUNK_SIZE = 32 * CHUNK_GRANULE; // 8 MiB
/** Google descarta la sesión a la semana; se da por caducada una hora antes. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

export interface ChunkRange {
  start: number;
  end: number;
  size: number;
}

/**
 * Subidas reanudables desde el navegador.
 *
 * A diferencia de `resumableUpload` (transferencias entre cuentas), aquí el
 * origen no se puede volver a abrir desde el servidor: los bytes solo los
 * tiene el navegador. Por eso quien lleva la cuenta de por dónde va es el
 * cliente: envía bloques, y tras un corte pregunta cuántos bytes confirmó
 * Google y reenvía desde ahí. El servidor solo reenvía cada bloque en
 * streaming y guarda la URL de la sesión, que nunca sale de aquí.
 */
@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: DriveClientFactory,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  async create(ctx: DriveContext, dto: CreateUploadSessionDto): Promise<UploadSessionView> {
    // Se rechaza antes de abrir nada: la subida multipart lo detecta a mitad,
    // aquí el tamaño se conoce de antemano.
    if (dto.size > this.config.drive.uploadMaxBytes) {
      throw new PayloadTooLargeException(
        `El archivo supera el límite de ${this.config.drive.uploadMaxBytes} bytes configurado en UPLOAD_MAX_BYTES`,
      );
    }
    void this.purgeExpired();

    const target = {
      name: dto.name.trim(),
      mimeType: dto.mimeType?.trim() || 'application/octet-stream',
      parentId: dto.parentId ?? 'root',
      size: dto.size,
    };
    const sessionUrl = await this.google(ctx, 'uploads.start', () =>
      withRetry(() => startSession(ctx.auth, { ...target, fields: FILE_FIELDS }), {
        retries: this.config.drive.maxRetries,
        baseDelayMs: this.config.drive.retryBaseDelayMs,
        operation: `abrir la subida de "${target.name}"`,
        logger: this.logger,
      }),
    );

    const session = await this.prisma.uploadSession.create({
      data: {
        accountId: ctx.account.id,
        sessionUrl,
        ...target,
        size: BigInt(target.size),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return toView(session, 0);
  }

  /** Cuántos bytes tiene Google; si ya los tiene todos, el archivo creado. */
  async status(ctx: DriveContext, uploadId: string): Promise<UploadSessionView> {
    const session = await this.find(ctx, uploadId);
    const state = await this.google(ctx, 'uploads.status', () =>
      withRetry(() => querySession(ctx.auth, session.sessionUrl, Number(session.size)), {
        retries: this.config.drive.maxRetries,
        baseDelayMs: this.config.drive.retryBaseDelayMs,
        operation: `estado de la subida de "${session.name}"`,
        logger: this.logger,
      }),
      session,
    );
    return this.settle(ctx, session, state);
  }

  /**
   * Reenvía un bloque a Google tal como llega, sin bufferizarlo. No se
   * reintenta: el cuerpo de la petición solo se puede leer una vez.
   */
  async putChunk(
    ctx: DriveContext,
    uploadId: string,
    headers: { contentRange?: string; contentLength?: string },
    body: Readable,
  ): Promise<UploadSessionView> {
    const session = await this.find(ctx, uploadId);
    const range = parseChunkRange(headers.contentRange, headers.contentLength, Number(session.size));

    let state: SessionStatus;
    try {
      state = await sendChunk(ctx.auth, session.sessionUrl, range, body);
    } catch (error) {
      if (!isResumable(error)) return this.fail(ctx, session, 'uploads.chunk', error);
      const { status, message } = normalizeGoogleError(error);
      // El siguiente bloque se envía en otra petición, que resuelve el
      // cliente de nuevo: basta con descartar el token que Google rechazó.
      if (status === 401) this.clients.invalidateToken(ctx.account.id);
      this.logger.warn(
        `Bloque ${range.start}-${range.end} de "${session.name}" interrumpido (status=${status ?? 'n/a'}: ${message})`,
      );
      throw new UploadInterruptedException(session.id, message);
    }
    return this.settle(ctx, session, state);
  }

  /** Cancela en Google (que libera lo ya subido) y olvida la sesión. */
  async cancel(ctx: DriveContext, uploadId: string): Promise<void> {
    const session = await this.find(ctx, uploadId);
    try {
      await cancelSession(ctx.auth, session.sessionUrl);
    } catch (error) {
      // Si Google no la cancela, caducará sola a la semana: no merece la pena
      // dejar al usuario con una subida que no puede quitar de su lista.
      this.logger.warn(
        `No se pudo cancelar en Google la subida de "${session.name}": ${normalizeGoogleError(error).message}`,
      );
    }
    await this.prisma.uploadSession.deleteMany({ where: { id: session.id } });
  }

  private async find(ctx: DriveContext, uploadId: string): Promise<UploadSession> {
    // Filtrar por la cuenta ya resuelta para el usuario es lo que impide usar
    // el id de una subida ajena.
    const session = await this.prisma.uploadSession.findFirst({
      where: { id: uploadId, accountId: ctx.account.id, expiresAt: { gt: new Date() } },
    });
    if (!session) throw new UploadSessionNotFoundException(uploadId);
    return session;
  }

  private async settle(
    ctx: DriveContext,
    session: UploadSession,
    state: SessionStatus,
  ): Promise<UploadSessionView> {
    if (!('file' in state)) return toView(session, state.offset);

    await this.prisma.uploadSession.deleteMany({ where: { id: session.id } });
    this.logger.log(`Subido "${state.file.name}" (${state.file.id}) a ${ctx.account.email} por bloques`);
    return { ...toView(session, Number(session.size)), file: toFileView(state.file, ctx.account) };
  }

  private async google<T>(
    ctx: DriveContext,
    operation: string,
    fn: () => Promise<T>,
    session?: UploadSession,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      return this.fail(ctx, session, operation, error);
    }
  }

  private async fail(
    ctx: DriveContext,
    session: UploadSession | undefined,
    operation: string,
    error: unknown,
  ): Promise<never> {
    if (error instanceof HttpException) throw error;
    const { status, message } = normalizeGoogleError(error);
    // 404/410: Google ya no conoce la sesión. Reintentar no la recupera, así
    // que se olvida y el cliente sabe que debe empezar de cero.
    if (session && (status === 404 || status === 410)) {
      await this.prisma.uploadSession.deleteMany({ where: { id: session.id } });
      throw new UploadSessionExpiredException(session.id);
    }
    if (status === 401) this.clients.invalidateToken(ctx.account.id);
    throw new GoogleApiException(operation, status, message);
  }

  private async purgeExpired(): Promise<void> {
    try {
      await this.prisma.uploadSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    } catch (error) {
      this.logger.warn(`No se pudieron purgar las subidas caducadas: ${String(error)}`);
    }
  }
}

/**
 * Valida `Content-Range: bytes start-end/total` antes de abrir nada contra
 * Google: un rango mal formado haría que Google respondiese con un error poco
 * claro, o peor, que aceptase un bloque que deja la sesión inservible.
 */
export function parseChunkRange(
  contentRange: string | undefined,
  contentLength: string | undefined,
  size: number,
): ChunkRange {
  const match = contentRange ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim()) : null;
  if (!match) {
    throw new BadRequestException('Falta Content-Range o no tiene la forma "bytes inicio-fin/total"');
  }
  const [start, end, total] = match.slice(1).map(Number) as [number, number, number];
  if (total !== size) {
    throw new BadRequestException(`El total del Content-Range (${total}) no coincide con el tamaño de la subida (${size})`);
  }
  if (start > end || end >= size) {
    throw new BadRequestException(`Rango ${start}-${end} fuera del archivo (${size} bytes)`);
  }

  const length = end - start + 1;
  // Sin Content-Length no se puede garantizar que el bloque llegue entero a
  // Google; con un cuerpo `chunked`, un corte parecería un bloque más corto.
  if (contentLength === undefined) {
    throw new HttpException('Falta Content-Length', HttpStatus.LENGTH_REQUIRED);
  }
  if (Number(contentLength) !== length) {
    throw new BadRequestException(`Content-Length (${contentLength}) no coincide con el rango (${length} bytes)`);
  }
  if (end !== size - 1 && length % CHUNK_GRANULE !== 0) {
    throw new BadRequestException(
      `Todo bloque salvo el último debe medir un múltiplo de ${CHUNK_GRANULE} bytes (recibido ${length})`,
    );
  }
  return { start, end, size };
}

function toView(session: UploadSession, offset: number): UploadSessionView {
  return {
    id: session.id,
    accountId: session.accountId,
    name: session.name,
    size: Number(session.size),
    offset,
    chunkSize: CHUNK_SIZE,
    expiresAt: session.expiresAt.toISOString(),
  };
}

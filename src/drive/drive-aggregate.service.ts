import { BadRequestException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleAccount } from '@prisma/client';
import { Readable, Transform } from 'node:stream';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { DriveClientFactory, DriveContext } from '../google/drive-client.factory';
import { DriveService, escapeQueryValue } from './drive.service';
import {
  AccountFailure,
  AggregateQuota,
  AggregateResult,
  PlannedMove,
  RebalancePlan,
  TransferResult,
} from './drive-aggregate.types';
import {
  DriveFilePage,
  FILE_FIELDS,
  FOLDER_MIME_TYPE,
  isGoogleNative,
  toAccountRef,
  toFileView,
} from './drive.types';
import { SearchQueryDto, TransferDto } from './dto/drive.dto';

/**
 * Operaciones que abarcan TODAS las cuentas de Google de un tenant.
 *
 * Es el valor diferencial del producto: el usuario ve un único Drive aunque
 * por debajo haya N cuentas con 15 GB cada una. El patrón es siempre el
 * mismo: fan-out en paralelo con `allSettled` y resultado tolerante a fallos
 * parciales, porque una cuenta caída no debe invalidar la respuesta entera.
 */
@Injectable()
export class DriveAggregateService {
  private readonly logger = new Logger(DriveAggregateService.name);

  constructor(
    private readonly clients: DriveClientFactory,
    private readonly drive: DriveService,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  /** Cuota de cada cuenta más los totales del tenant. */
  async quota(userId: string): Promise<AggregateQuota> {
    const { results, failures } = await this.fanOut(userId, (ctx) => this.drive.getQuota(ctx));

    const hasUnlimited = results.some((quota) => quota.limit === null);
    const limit = hasUnlimited
      ? null
      : results.reduce((sum, quota) => sum + (quota.limit ?? 0), 0);
    const usage = results.reduce((sum, quota) => sum + quota.usage, 0);

    const withFreeSpace = results
      .filter((quota) => quota.freeBytes !== null || quota.limit === null)
      .sort((a, b) => (b.freeBytes ?? Infinity) - (a.freeBytes ?? Infinity));

    return {
      results,
      failures,
      totals: { limit, usage, freeBytes: limit === null ? null : Math.max(limit - usage, 0) },
      recommendedAccountId: withFreeSpace[0]?.account.id ?? null,
    };
  }

  /** Búsqueda global: la misma consulta contra todas las cuentas a la vez. */
  async search(userId: string, dto: SearchQueryDto): Promise<AggregateResult<DriveFilePage>> {
    const term = escapeQueryValue(dto.q.trim());
    const clauses = [
      `(name contains '${term}' or fullText contains '${term}')`,
      'trashed = false',
    ];
    if (dto.mimeType) {
      clauses.push(`mimeType = '${escapeQueryValue(dto.mimeType)}'`);
    }

    return this.fanOut(
      userId,
      async (ctx) => {
        const response = await this.rawList(ctx, clauses.join(' and '), {
          pageSize: dto.limitPerAccount ?? 25,
          orderBy: 'modifiedTime desc',
        });
        return {
          files: (response.files ?? []).map((file) => toFileView(file, ctx.account)),
          nextPageToken: response.nextPageToken ?? null,
          incompleteSearch: response.incompleteSearch ?? false,
          account: toAccountRef(ctx.account),
        } satisfies DriveFilePage;
      },
      dto.accountIds,
    );
  }

  /** Listado unificado de la raíz (o de una carpeta) de cada cuenta. */
  async listAll(userId: string, pageSize = 50): Promise<AggregateResult<DriveFilePage>> {
    return this.fanOut(userId, (ctx) =>
      this.drive.listFiles(ctx, { pageSize, kind: 'all' }),
    );
  }

  /**
   * Copia un archivo de una cuenta de Google a otra haciendo streaming
   * descarga→subida, sin tocar disco ni acumularlo en memoria.
   *
   * Entre cuentas distintas no existe un "move" nativo en la Drive API (son
   * usuarios de Google diferentes), así que mover = copiar y, SOLO si la copia
   * se verifica íntegra, enviar el original a la papelera. Nunca borramos sin
   * verificar, y el borrado permanente solo ocurre si el usuario lo pide con
   * `permanentlyDeleteSource`.
   */
  async transfer(
    userId: string,
    dto: TransferDto,
    options: TransferOptions = {},
  ): Promise<TransferResult> {
    const startedAt = Date.now();

    if (dto.permanentlyDeleteSource && !dto.deleteSource) {
      // Sin deleteSource el original no se toca: aceptar el flag en solitario
      // haría creer al cliente que se iba a liberar espacio.
      throw new BadRequestException('permanentlyDeleteSource requiere deleteSource=true');
    }

    if (dto.from.accountId === dto.to.accountId) {
      // Misma cuenta: `files.copy` lo hace del lado de Google, sin mover bytes
      // por nuestra red. Pedir una transferencia así casi siempre es un error
      // del cliente, pero resolverlo bien es trivial y mucho más rápido.
      return this.copyWithinAccount(userId, dto, startedAt);
    }

    const source = await this.clients.forAccount(userId, dto.from.accountId);
    const target = await this.clients.forAccount(userId, dto.to.accountId);

    const meta = await this.drive.getFile(source, dto.from.fileId);
    if (meta.isFolder) {
      throw new BadRequestException(
        'Transferir una carpeta completa entre cuentas no está soportado: ' +
          'crea la carpeta en destino y transfiere sus archivos.',
      );
    }

    const native = isGoogleNative(meta.mimeType);
    if (native && dto.deleteSource) {
      // Un Doc de Google se exporta a .docx: la copia NO es idéntica al
      // original, así que no podemos verificar integridad y borrar sería
      // destruir el único ejemplar del documento vivo.
      throw new BadRequestException(
        `"${meta.name}" es un documento nativo de Google: la copia es una conversión ` +
          'de formato, no un duplicado. Se puede copiar, pero no borrar el original ' +
          '(deleteSource debe ser false).',
      );
    }

    // Un archivo binario se puede volver a pedir desde cualquier byte, así que
    // un corte a mitad se reanuda en vez de repetir la subida entera.
    const size = native ? null : meta.size;
    const uploaded = size
      ? await this.uploadBinary(source, target, dto, { ...meta, size }, options)
      : await this.uploadExport(source, target, dto, meta.size, options);

    // Preferimos md5 (detecta corrupción); el tamaño es el respaldo cuando
    // Google no publica checksum para ese archivo.
    const md5Matches =
      Boolean(meta.md5Checksum) && meta.md5Checksum === uploaded.md5Checksum;
    const sizeMatches = meta.size !== null && meta.size === uploaded.size;
    const verification = md5Matches ? 'md5' : sizeMatches ? 'size' : 'none';
    const verified = verification !== 'none';

    let sourceTrashed = false;
    let sourceDeleted = false;
    if (dto.deleteSource) {
      if (!verified) {
        throw new BadRequestException(
          `La copia de "${meta.name}" se subió a ${target.account.email} pero no se pudo ` +
            'verificar su integridad (ni md5 ni tamaño coinciden). El original NO se ha ' +
            `tocado. Revisa la copia (${uploaded.id}) antes de borrar el original.`,
        );
      }
      // Por defecto, papelera: el usuario conserva 30 días para deshacer si la
      // transferencia no era lo que esperaba, a costa de que la cuota no se
      // libere hasta entonces.
      const permanent = dto.permanentlyDeleteSource === true;
      await this.drive.deleteFile(source, dto.from.fileId, permanent);
      sourceTrashed = !permanent;
      sourceDeleted = permanent;
    }

    const fate = sourceDeleted ? ', original borrado' : sourceTrashed ? ', original a papelera' : '';
    this.logger.log(
      `Transferido "${meta.name}" de ${source.account.email} a ${target.account.email} ` +
        `(verificación: ${verification}${fate})`,
    );

    return {
      source: {
        account: toAccountRef(source.account),
        fileId: dto.from.fileId,
        name: meta.name,
        size: meta.size,
      },
      uploaded,
      verified,
      verification,
      sourceTrashed,
      sourceDeleted,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Subida reanudable: ver `DriveService.uploadResumable`. */
  private uploadBinary(
    source: DriveContext,
    target: DriveContext,
    dto: TransferDto,
    meta: { name: string; mimeType: string; size: number },
    options: TransferOptions,
  ) {
    return this.drive.uploadResumable(
      target,
      { name: dto.to.name?.trim() || meta.name, mimeType: meta.mimeType, size: meta.size },
      async (offset) => {
        // Cada apertura resuelve de nuevo el cliente del origen: en una
        // transferencia larga, el token con el que empezó puede caducar.
        const fresh = await this.clients.forResolvedAccount(source.account);
        const stream = await this.drive.openMedia(fresh, dto.from.fileId, offset);
        return options.onProgress
          ? trackProgress(stream, meta.size, options.onProgress, offset)
          : stream;
      },
      { parentId: dto.to.parentId },
    );
  }

  /**
   * Camino de los documentos de Google (y de los archivos vacíos): se
   * exportan sin tamaño conocido, así que no hay forma de reanudar y van en
   * una sola subida multipart. Son pequeños, así que repetirlos cuesta poco.
   */
  private async uploadExport(
    source: DriveContext,
    target: DriveContext,
    dto: TransferDto,
    size: number | null,
    options: TransferOptions,
  ) {
    const download = await this.drive.download(source, dto.from.fileId);

    // Los bytes bajan de la cuenta origen y suben a la destino sin pasar por
    // disco; el contador intermedio solo observa el caudal para informar del
    // progreso, no acumula nada.
    const body =
      options.onProgress && size
        ? trackProgress(download.stream, size, options.onProgress)
        : download.stream;

    return this.drive.uploadFile(
      target,
      {
        stream: body,
        filename: dto.to.name?.trim() || download.filename,
        mimeType: download.mimeType,
      },
      { parentId: dto.to.parentId },
    );
  }

  /**
   * Propone cómo redistribuir archivos para bajar de un umbral de cuota.
   *
   * Solo PROPONE: no mueve nada. La ejecución la dispara siempre el usuario
   * sobre los movimientos que acepte, para que el sistema nunca mueva
   * archivos de nadie por decisión propia.
   */
  async rebalancePlan(
    userId: string,
    options: { threshold?: number; maxMoves?: number } = {},
  ): Promise<RebalancePlan> {
    const threshold = options.threshold ?? this.config.rebalance.threshold;
    const maxMoves = options.maxMoves ?? this.config.rebalance.maxMoves;
    const notes: string[] = [];

    const accounts = await this.clients.listAccounts(userId);
    const { results: quotas, failures } = await this.fanOutOver(accounts, (ctx) =>
      this.drive.getQuota(ctx),
    );

    const byId = new Map(accounts.map((account) => [account.id, account]));

    const underPressure = quotas
      .filter((quota) => quota.usedPercent !== null && quota.usedPercent / 100 >= threshold)
      .map((quota) => ({
        account: quota.account,
        usedPercent: quota.usedPercent ?? 0,
        // Bytes a liberar para quedar justo por debajo del umbral.
        bytesToFree: Math.max(Math.ceil(quota.usage - threshold * (quota.limit ?? 0)), 0),
      }))
      .sort((a, b) => b.usedPercent - a.usedPercent);

    if (underPressure.length === 0) {
      notes.push(
        `Ninguna cuenta supera el ${Math.round(threshold * 100)} % de su cuota: no hace falta redistribuir.`,
      );
      return {
        threshold,
        quotas,
        underPressure: [],
        moves: [],
        freedBytes: 0,
        unresolvedBytes: 0,
        notes,
        failures,
      };
    }

    // Espacio libre simulado de los posibles destinos: se va descontando a
    // medida que el plan asigna archivos, para no proponer dos movimientos
    // que juntos no caben.
    const pressuredIds = new Set(underPressure.map((item) => item.account.id));
    const capacity = quotas
      .filter((quota) => !pressuredIds.has(quota.account.id))
      .map((quota) => ({
        account: quota.account,
        // Reservamos el mismo margen en destino: llenar otra cuenta hasta el
        // 100 % solo traslada el problema.
        free:
          quota.limit === null
            ? Number.MAX_SAFE_INTEGER
            : Math.max(Math.floor(threshold * quota.limit - quota.usage), 0),
      }))
      .filter((target) => target.free > 0)
      .sort((a, b) => b.free - a.free);

    if (capacity.length === 0) {
      notes.push(
        'No hay ninguna cuenta con espacio libre suficiente por debajo del umbral. ' +
          'Vincula otra cuenta de Google para poder redistribuir.',
      );
    }

    const moves: PlannedMove[] = [];
    let freedBytes = 0;
    let unresolvedBytes = 0;

    for (const pressure of underPressure) {
      const account = byId.get(pressure.account.id);
      if (!account) continue;

      let remaining = pressure.bytesToFree;
      if (capacity.length === 0) {
        unresolvedBytes += remaining;
        continue;
      }

      const candidates = await this.largestOwnedFiles(account);
      if (candidates.length === 0) {
        notes.push(
          `${pressure.account.email}: no se encontraron archivos propios movibles ` +
            '(los documentos nativos de Google no ocupan cuota y los archivos de otros ' +
            'propietarios no cuentan en la tuya).',
        );
      }

      for (const candidate of candidates) {
        if (remaining <= 0 || moves.length >= maxMoves) break;

        // Destino: el que más hueco tenga y quepa el archivo entero.
        capacity.sort((a, b) => b.free - a.free);
        const target = capacity.find((option) => option.free >= candidate.size);
        if (!target) continue;

        target.free -= candidate.size;
        remaining -= candidate.size;
        freedBytes += candidate.size;
        moves.push({
          file: candidate,
          from: pressure.account,
          to: target.account,
          bytes: candidate.size,
        });
      }

      if (remaining > 0) {
        unresolvedBytes += remaining;
      }
    }

    if (moves.length >= maxMoves) {
      notes.push(
        `El plan se detuvo en el máximo de ${maxMoves} movimientos (REBALANCE_MAX_MOVES). ` +
          'Ejecútalos y vuelve a pedir el plan para continuar.',
      );
    }

    notes.push(
      'Este plan no se ha ejecutado. Para aplicarlo, lanza POST /drive/transfers por cada ' +
        'movimiento que aceptes (con deleteSource=true para que se libere la cuenta origen).',
    );

    return { threshold, quotas, underPressure, moves, freedBytes, unresolvedBytes, notes, failures };
  }

  /**
   * Archivos propios más grandes de una cuenta, que son los candidatos a mover.
   *
   * Filtros importantes:
   *  - `'me' in owners`: solo lo que es tuyo consume TU cuota.
   *  - documentos nativos de Google: ocupan 0 bytes, moverlos no libera nada.
   *  - carpetas y atajos: no tienen bytes propios.
   */
  private async largestOwnedFiles(account: GoogleAccount) {
    const ctx = await this.clients.forResolvedAccount(account);
    const response = await this.rawList(
      ctx,
      [
        'trashed = false',
        `mimeType != '${FOLDER_MIME_TYPE}'`,
        "'me' in owners",
      ].join(' and '),
      {
        pageSize: Math.min(this.config.rebalance.candidateSampleSize, 1000),
        orderBy: 'quotaBytesUsed desc',
      },
    );

    return (response.files ?? [])
      .map((file) => ({
        id: file.id ?? '',
        name: file.name ?? '(sin nombre)',
        mimeType: file.mimeType ?? '',
        size: Number(file.size ?? 0),
      }))
      .filter((file) => file.id && file.size > 0 && !isGoogleNative(file.mimeType));
  }

  private async copyWithinAccount(
    userId: string,
    dto: TransferDto,
    startedAt: number,
  ): Promise<TransferResult> {
    const ctx = await this.clients.forAccount(userId, dto.from.accountId);
    const meta = await this.drive.getFile(ctx, dto.from.fileId);

    const uploaded = await this.drive.copyFile(ctx, dto.from.fileId, {
      name: dto.to.name?.trim() || `Copia de ${meta.name}`,
      parentId: dto.to.parentId,
    });
    let sourceTrashed = false;
    let sourceDeleted = false;
    if (dto.deleteSource) {
      const permanent = dto.permanentlyDeleteSource === true;
      await this.drive.deleteFile(ctx, dto.from.fileId, permanent);
      sourceTrashed = !permanent;
      sourceDeleted = permanent;
    }

    return {
      source: {
        account: toAccountRef(ctx.account),
        fileId: dto.from.fileId,
        name: meta.name,
        size: meta.size,
      },
      uploaded,
      verified: true,
      verification: 'md5',
      sourceTrashed,
      sourceDeleted,
      durationMs: Date.now() - startedAt,
    };
  }

  /** `files.list` crudo, para consultas que no encajan en el DTO de listado. */
  private async rawList(
    ctx: DriveContext,
    q: string,
    options: { pageSize: number; orderBy?: string },
  ) {
    const response = await ctx.drive.files.list({
      q,
      pageSize: options.pageSize,
      orderBy: options.orderBy,
      fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return response.data;
  }

  private async fanOut<T>(
    userId: string,
    task: (ctx: DriveContext) => Promise<T>,
    accountIds?: string[],
  ): Promise<AggregateResult<T>> {
    let accounts = await this.clients.listAccounts(userId);
    if (accountIds?.length) {
      const wanted = new Set(accountIds);
      accounts = accounts.filter((account) => wanted.has(account.id));
    }
    return this.fanOutOver(accounts, task);
  }

  /**
   * Ejecuta la misma tarea sobre varias cuentas en paralelo y separa éxitos de
   * fallos. `allSettled` es deliberado: con `Promise.all`, una sola cuenta en
   * NEEDS_REAUTH dejaría al usuario sin ver ninguna de las demás.
   */
  private async fanOutOver<T>(
    accounts: GoogleAccount[],
    task: (ctx: DriveContext) => Promise<T>,
  ): Promise<AggregateResult<T>> {
    const settled = await Promise.allSettled(
      accounts.map(async (account) => {
        const ctx = await this.clients.forResolvedAccount(account);
        return task(ctx);
      }),
    );

    const results: T[] = [];
    const failures: AccountFailure[] = [];

    settled.forEach((outcome, index) => {
      const account = accounts[index];
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        return;
      }

      const { code, message } = describeFailure(outcome.reason);
      this.logger.warn(`Cuenta ${account.email} falló en operación agregada: ${message}`);
      failures.push({ account: toAccountRef(account), code, message });
    });

    return { results, failures };
  }
}

/** Notificación de progreso de una transferencia, en porcentaje (0-100). */
export interface TransferOptions {
  onProgress?: (percent: number, bytesTransferred: number) => void;
}

/**
 * Observa cuántos bytes pasan por el stream y notifica el progreso.
 *
 * Se implementa como `Transform` y no con un listener de `'data'`: un listener
 * pondría el stream en modo *flowing* antes de que la subida empiece a
 * consumirlo, rompiendo la contrapresión y acumulando el archivo en memoria,
 * que es justo lo que este diseño quiere evitar. Un `Transform` solo mueve
 * datos cuando el destino los pide.
 *
 * Solo informa cuando el porcentaje avanza al menos un punto: cada
 * notificación del worker escribe en Redis y con un archivo grande serían
 * decenas de miles de escrituras inútiles.
 */
function trackProgress(
  source: Readable,
  totalBytes: number,
  onProgress: (percent: number, bytesTransferred: number) => void,
  /** Al reanudar, los bytes que ya estaban subidos. */
  startAt = 0,
): Readable {
  let transferred = startAt;
  let lastReported = Math.floor((startAt / totalBytes) * 100);

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      const percent = Math.min(Math.floor((transferred / totalBytes) * 100), 99);
      if (percent > lastReported) {
        lastReported = percent;
        onProgress(percent, transferred);
      }
      callback(null, chunk);
    },
    flush(callback) {
      onProgress(100, transferred);
      callback();
    },
  });

  // Sin esto, un fallo de la descarga dejaría la subida esperando bytes que
  // no van a llegar hasta agotar el timeout.
  source.on('error', (error) => counter.destroy(error));
  source.pipe(counter);

  return counter;
}

function describeFailure(reason: unknown): { code: string; message: string } {
  if (reason instanceof HttpException) {
    const body = reason.getResponse();
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>;
      return {
        code: typeof record.code === 'string' ? record.code : 'HTTP_ERROR',
        message: typeof record.message === 'string' ? record.message : reason.message,
      };
    }
    return { code: 'HTTP_ERROR', message: reason.message };
  }
  return {
    code: 'UNKNOWN',
    message: reason instanceof Error ? reason.message : 'Error desconocido',
  };
}

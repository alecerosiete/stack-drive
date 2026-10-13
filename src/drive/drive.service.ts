import { BadRequestException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { DriveClientFactory, DriveContext } from '../google/drive-client.factory';
import { GoogleApiException } from '../common/errors';
import { normalizeGoogleError } from '../common/google-error.util';
import { withRetry } from '../common/retry';
import {
  DriveDownload,
  DriveFilePage,
  DriveFileView,
  FILE_FIELDS,
  FOLDER_MIME_TYPE,
  GOOGLE_NATIVE_EXPORTS,
  isGoogleNative,
  StorageQuotaView,
  toAccountRef,
  toFileView,
  toTreeNode,
  TREE_FIELDS,
  TreeNode,
} from './drive.types';
import { CreateFolderDto, ListFilesQueryDto, UpdateFileDto } from './dto/drive.dto';
import { resumableUpload } from './resumable-upload';
import { IncomingFile } from './upload-stream.util';

interface RunOptions {
  /**
   * Los reintentos releen la petición desde cero, así que deben desactivarse
   * en operaciones que consumen un stream de subida: ese stream ya no se
   * puede rebobinar.
   */
  retry?: boolean;
}

/**
 * Capa de servicios de la Google Drive API v3 para UNA cuenta.
 *
 * Todos los métodos reciben un `DriveContext` ya resuelto (cuenta + cliente
 * autorizado), de modo que la misma lógica sirve para las operaciones de una
 * cuenta y para las agregadas multi-cuenta, sin duplicar código.
 */
@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    private readonly clients: DriveClientFactory,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  /** Resuelve la cuenta del tenant y obtiene un cliente con token fresco. */
  context(userId: string, accountId: string): Promise<DriveContext> {
    return this.clients.forAccount(userId, accountId);
  }

  async listFiles(ctx: DriveContext, query: ListFilesQueryDto): Promise<DriveFilePage> {
    const response = await this.run(ctx, 'files.list', (drive) =>
      drive.files.list({
        q: this.buildListQuery(query),
        pageSize: query.pageSize ?? 100,
        pageToken: query.pageToken,
        orderBy: this.buildOrderBy(query),
        fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
        // Incluimos unidades compartidas: con el scope `drive` completo el
        // usuario espera ver también lo que tiene en unidades de equipo.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );

    return {
      files: (response.data.files ?? []).map((file) => toFileView(file, ctx.account)),
      nextPageToken: response.data.nextPageToken ?? null,
      incompleteSearch: response.data.incompleteSearch ?? false,
      account: toAccountRef(ctx.account),
    };
  }

  async getFile(ctx: DriveContext, fileId: string): Promise<DriveFileView> {
    const response = await this.run(ctx, 'files.get', (drive) =>
      drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true }),
    );
    return toFileView(response.data, ctx.account);
  }

  async createFolder(ctx: DriveContext, dto: CreateFolderDto): Promise<DriveFileView> {
    const response = await this.run(ctx, 'files.create(folder)', (drive) =>
      drive.files.create({
        requestBody: {
          name: dto.name,
          mimeType: FOLDER_MIME_TYPE,
          parents: [dto.parentId ?? 'root'],
        },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      }),
    );
    return toFileView(response.data, ctx.account);
  }

  /**
   * Crea la ruta completa (`informes/2026/Q1`) creando los tramos que falten
   * y reutilizando los que ya existen. Pensado para organizar carpetas de
   * forma programática sin encadenar llamadas desde el cliente.
   */
  async ensureFolderPath(
    ctx: DriveContext,
    segments: string[],
    rootId = 'root',
  ): Promise<DriveFileView[]> {
    const created: DriveFileView[] = [];
    let parentId = rootId;

    for (const segment of segments) {
      const name = segment.trim();
      if (!name) continue;

      const folder =
        (await this.findFolderByName(ctx, parentId, name)) ??
        (await this.createFolder(ctx, { name, parentId }));

      created.push(folder);
      parentId = folder.id;
    }

    return created;
  }

  /** Carpeta (no en la papelera) con ese nombre exacto dentro de `parentId`. */
  async findFolderByName(
    ctx: DriveContext,
    parentId: string,
    name: string,
  ): Promise<DriveFileView | null> {
    const response = await this.run(ctx, 'files.list(folder lookup)', (drive) =>
      drive.files.list({
        q: [
          `name = '${escapeQueryValue(name)}'`,
          `'${escapeQueryValue(parentId)}' in parents`,
          `mimeType = '${FOLDER_MIME_TYPE}'`,
          'trashed = false',
        ].join(' and '),
        pageSize: 1,
        fields: `files(${FILE_FIELDS})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    const found = response.data.files?.[0];
    return found ? toFileView(found, ctx.account) : null;
  }

  /**
   * TODOS los hijos directos de una carpeta, recorriendo la paginación.
   * Incluye `ownedByMe`, que el listado normal no pide: decide si un archivo
   * se puede borrar tras moverlo.
   */
  async listChildren(ctx: DriveContext, folderId: string): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.run(ctx, 'files.list(children)', (drive) =>
        drive.files.list({
          q: `'${escapeQueryValue(folderId)}' in parents and trashed = false`,
          pageSize: 1000,
          pageToken,
          fields: `nextPageToken,files(${TREE_FIELDS})`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      );
      nodes.push(...(response.data.files ?? []).map(toTreeNode));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return nodes;
  }

  /** Metadatos de un elemento en la forma que usan los recorridos de árbol. */
  async getTreeNode(ctx: DriveContext, fileId: string): Promise<TreeNode> {
    const response = await this.run(ctx, 'files.get(tree)', (drive) =>
      drive.files.get({ fileId, fields: TREE_FIELDS, supportsAllDrives: true }),
    );
    return toTreeNode(response.data);
  }

  /**
   * Sube un archivo haciendo streaming directo del cliente a Google: el
   * backend no lo guarda ni en memoria ni en disco (requisito de coste cero
   * de almacenamiento central).
   */
  async uploadFile(
    ctx: DriveContext,
    file: IncomingFile,
    options: { parentId?: string; name?: string },
  ): Promise<DriveFileView> {
    const response = await this.run(
      ctx,
      'files.create(upload)',
      (drive) =>
        drive.files.create(
          {
            requestBody: {
              name: options.name?.trim() || file.filename,
              parents: [options.parentId ?? 'root'],
            },
            media: { mimeType: file.mimeType, body: file.stream },
            fields: FILE_FIELDS,
            supportsAllDrives: true,
          },
          // Sin timeout: una subida grande puede durar bastante más que el
          // valor por defecto de Gaxios.
          { timeout: 0 },
        ),
      { retry: false },
    );

    this.logger.log(
      `Subido "${response.data.name}" (${response.data.id}) a ${ctx.account.email}`,
    );
    return toFileView(response.data, ctx.account);
  }

  /**
   * Sube un archivo cuyo origen se puede volver a abrir desde cualquier byte
   * (otra cuenta de Google), con el protocolo *resumable*: si la conexión se
   * corta a mitad, continúa desde lo que Google ya confirmó en vez de repetir
   * la subida entera. Ver `resumable-upload.ts`.
   */
  async uploadResumable(
    ctx: DriveContext,
    file: { name: string; mimeType: string; size: number },
    openSource: (offset: number) => Promise<Readable>,
    options: { parentId?: string },
  ): Promise<DriveFileView> {
    try {
      const uploaded = await resumableUpload({
        ...file,
        parentId: options.parentId ?? 'root',
        fields: FILE_FIELDS,
        authorize: async ({ stale }) => {
          if (stale) this.clients.invalidateToken(ctx.account.id);
          return (await this.clients.forResolvedAccount(ctx.account)).auth;
        },
        openSource,
        maxResumes: this.config.drive.maxRetries,
        baseDelayMs: this.config.drive.retryBaseDelayMs,
        logger: this.logger,
      });
      this.logger.log(`Subido "${uploaded.name}" (${uploaded.id}) a ${ctx.account.email}`);
      return toFileView(uploaded, ctx.account);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const { status, message } = normalizeGoogleError(error);
      throw new GoogleApiException('upload(resumable)', status, message);
    }
  }

  /**
   * Abre los bytes de un archivo binario a partir de `offset`. Sirve para
   * reanudar una transferencia sin volver a descargar lo ya subido.
   */
  async openMedia(ctx: DriveContext, fileId: string, offset = 0): Promise<Readable> {
    const response = await this.run(ctx, 'files.get(media)', (drive) =>
      drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        {
          responseType: 'stream',
          timeout: 0,
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
        },
      ),
    );
    const stream = response.data as unknown as Readable;
    // Si Google ignorase el Range devolvería el archivo entero (200), y
    // concatenarlo tras lo ya subido corrompería la copia en silencio.
    if (offset > 0 && response.status !== 206) {
      stream.destroy();
      throw new GoogleApiException(
        'files.get(media)',
        response.status,
        `Se pidió el archivo desde el byte ${offset} y Google devolvió ${response.status}, no 206`,
      );
    }
    return stream;
  }

  /**
   * Duplica un archivo dentro de la MISMA cuenta. Lo hace Google de su lado:
   * los bytes no viajan por nuestra red.
   */
  async copyFile(
    ctx: DriveContext,
    fileId: string,
    options: { name?: string; parentId?: string },
  ): Promise<DriveFileView> {
    const response = await this.run(ctx, 'files.copy', (drive) =>
      drive.files.copy({
        fileId,
        requestBody: {
          name: options.name,
          parents: [options.parentId ?? 'root'],
        },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      }),
    );
    return toFileView(response.data, ctx.account);
  }

  /** Renombrar y/o mover dentro de la misma cuenta de Google. */
  async updateFile(ctx: DriveContext, fileId: string, dto: UpdateFileDto): Promise<DriveFileView> {
    let addParents: string | undefined;
    let removeParents: string | undefined;

    if (dto.parentId) {
      // Mover en Drive v3 es reasignar padres, no un campo editable: hay que
      // decirle explícitamente de dónde quitarlo.
      const current = await this.getFile(ctx, fileId);
      if (!current.parents.includes(dto.parentId)) {
        addParents = dto.parentId;
        removeParents = current.parents.join(',') || undefined;
      }
    }

    const requestBody: drive_v3.Schema$File = {};
    if (dto.name !== undefined) requestBody.name = dto.name.trim();
    if (dto.trashed !== undefined) requestBody.trashed = dto.trashed;

    if (!addParents && Object.keys(requestBody).length === 0) {
      throw new BadRequestException('Indica al menos uno de: name, parentId o trashed');
    }

    const response = await this.run(ctx, 'files.update', (drive) =>
      drive.files.update({
        fileId,
        requestBody,
        addParents,
        removeParents,
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      }),
    );
    return toFileView(response.data, ctx.account);
  }

  /**
   * Borra un elemento. Por defecto va a la papelera (reversible por el
   * usuario desde Drive); `permanent` lo elimina sin posibilidad de deshacer.
   */
  async deleteFile(ctx: DriveContext, fileId: string, permanent: boolean): Promise<void> {
    if (permanent) {
      await this.run(ctx, 'files.delete', (drive) =>
        drive.files.delete({ fileId, supportsAllDrives: true }),
      );
      return;
    }

    await this.run(ctx, 'files.update(trash)', (drive) =>
      drive.files.update({
        fileId,
        requestBody: { trashed: true },
        fields: 'id',
        supportsAllDrives: true,
      }),
    );
  }

  /**
   * Vacía la papelera de la cuenta, que es lo único que libera la cuota de lo
   * que se envió allí (las transferencias, por defecto, mandan el original a
   * la papelera). Es irreversible y afecta a TODO lo que haya en ella, no solo
   * a lo que movió StackDrive: solo se ejecuta a petición explícita.
   *
   * Devuelve la cuota anterior al vaciado: Google tarda en recalcular la
   * nueva, así que leerla justo después daría la cifra vieja.
   */
  async emptyTrash(ctx: DriveContext): Promise<{ freedBytes: number }> {
    const before = await this.getQuota(ctx);
    await this.run(ctx, 'files.emptyTrash', (drive) => drive.files.emptyTrash({}));
    this.logger.log(
      `Papelera vaciada en ${ctx.account.email} (~${before.usageInDriveTrash} bytes)`,
    );
    return { freedBytes: before.usageInDriveTrash };
  }

  /**
   * Abre el flujo binario de un archivo. Los documentos nativos de Google se
   * exportan a su equivalente de Office, porque no tienen bytes propios.
   */
  async download(ctx: DriveContext, fileId: string): Promise<DriveDownload> {
    const meta = await this.getFile(ctx, fileId);

    if (meta.isFolder) {
      throw new BadRequestException('No se puede descargar una carpeta');
    }

    if (isGoogleNative(meta.mimeType)) {
      const target = GOOGLE_NATIVE_EXPORTS[meta.mimeType];
      if (!target) {
        throw new BadRequestException(
          `El tipo nativo de Google "${meta.mimeType}" no admite exportación directa. ` +
            'Usa el enlace webViewLink para abrirlo en Drive.',
        );
      }

      const response = await this.run(ctx, 'files.export', (drive) =>
        drive.files.export({ fileId, mimeType: target.mimeType }, { responseType: 'stream' }),
      );

      return {
        stream: response.data as unknown as Readable,
        filename: `${meta.name}.${target.extension}`,
        mimeType: target.mimeType,
        size: null,
      };
    }

    return {
      stream: await this.openMedia(ctx, fileId),
      filename: meta.name,
      mimeType: meta.mimeType,
      size: meta.size,
    };
  }

  /** Enlaces de visualización y de descarga directa que ofrece Google. */
  async getLinks(ctx: DriveContext, fileId: string) {
    const file = await this.getFile(ctx, fileId);
    return {
      fileId: file.id,
      name: file.name,
      webViewLink: file.webViewLink,
      webContentLink: file.webContentLink,
      /** Enlace propio de StackDrive, que sí funciona con nuestro Bearer. */
      proxyDownloadPath: `/drive/${ctx.account.id}/files/${file.id}/download`,
      account: file.account,
    };
  }

  async getQuota(ctx: DriveContext): Promise<StorageQuotaView> {
    const response = await this.run(ctx, 'about.get', (drive) =>
      drive.about.get({ fields: 'storageQuota' }),
    );

    const quota = response.data.storageQuota ?? {};
    // `limit` viene ausente en cuentas con almacenamiento ilimitado.
    const limit = quota.limit !== undefined && quota.limit !== null ? Number(quota.limit) : null;
    const usage = Number(quota.usage ?? 0);
    const usageInDrive = Number(quota.usageInDrive ?? 0);

    return {
      account: toAccountRef(ctx.account),
      limit,
      usage,
      usageInDrive,
      usageInDriveTrash: Number(quota.usageInDriveTrash ?? 0),
      usageOutsideDrive: Math.max(usage - usageInDrive, 0),
      freeBytes: limit === null ? null : Math.max(limit - usage, 0),
      usedPercent: limit === null || limit === 0 ? null : Math.round((usage / limit) * 1000) / 10,
    };
  }

  /**
   * Construye el parámetro `q` de la Drive API.
   *
   * Los valores se escapan: un nombre con apóstrofo (`O'Brien.pdf`) rompería
   * la consulta o permitiría inyectar cláusulas.
   */
  private buildListQuery(query: ListFilesQueryDto): string {
    const clauses: string[] = [`'${escapeQueryValue(query.parentId ?? 'root')}' in parents`];

    if (!query.includeTrashed) {
      clauses.push('trashed = false');
    }
    if (query.name) {
      clauses.push(`name contains '${escapeQueryValue(query.name)}'`);
    }
    if (query.mimeType) {
      clauses.push(`mimeType = '${escapeQueryValue(query.mimeType)}'`);
    }
    if (query.kind === 'folders') {
      clauses.push(`mimeType = '${FOLDER_MIME_TYPE}'`);
    } else if (query.kind === 'files') {
      clauses.push(`mimeType != '${FOLDER_MIME_TYPE}'`);
    }

    return clauses.join(' and ');
  }

  private buildOrderBy(query: ListFilesQueryDto): string {
    // Por defecto, carpetas primero y luego por nombre: es el orden que
    // espera cualquiera que haya usado un explorador de archivos.
    const field = query.orderBy ?? 'folder,name';
    return query.descending
      ? field
          .split(',')
          .map((part) => `${part} desc`)
          .join(',')
      : field;
  }

  /**
   * Ejecuta una llamada a Drive con reintentos y traducción de errores.
   *
   * Un 401 aquí significa que el `access_token` cacheado dejó de valer antes
   * de lo previsto (revocación, cambio de permisos, desfase de reloj): se
   * descarta el token, se reconstruye el cliente y se intenta una vez más.
   */
  private async run<T>(
    ctx: DriveContext,
    operation: string,
    fn: (drive: drive_v3.Drive) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    const retries = options.retry === false ? 0 : this.config.drive.maxRetries;

    try {
      return await withRetry(() => fn(ctx.drive), {
        retries,
        baseDelayMs: this.config.drive.retryBaseDelayMs,
        operation: `${operation} (${ctx.account.email})`,
        logger: this.logger,
      });
    } catch (error) {
      const { status, message } = normalizeGoogleError(error);

      if (status === 401 && options.retry !== false) {
        this.logger.warn(
          `401 en ${operation} para ${ctx.account.email}: se descarta el access_token y se reintenta`,
        );
        this.clients.invalidateToken(ctx.account.id);
        const fresh = await this.clients.forResolvedAccount(ctx.account);

        try {
          return await fn(fresh.drive);
        } catch (retryError) {
          const retried = normalizeGoogleError(retryError);
          throw new GoogleApiException(operation, retried.status, retried.message);
        }
      }

      throw new GoogleApiException(operation, status, message);
    }
  }
}

/** Escapa los caracteres con significado en el lenguaje de consulta de Drive. */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

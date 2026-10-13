import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DriveClientFactory, DriveContext } from '../google/drive-client.factory';
import { DriveService } from './drive.service';
import { DriveAggregateService } from './drive-aggregate.service';
import {
  BatchItemOutcome,
  BatchItemStatus,
  BatchProgress,
  BatchTransferResult,
  TransferPreview,
} from './drive-aggregate.types';
import {
  GOOGLE_NATIVE_EXPORTS,
  isGoogleNative,
  SHORTCUT_MIME_TYPE,
  toAccountRef,
  TreeNode,
} from './drive.types';
import { BatchTransferDto, TransferDto, TransferPreviewDto } from './dto/drive.dto';

/**
 * Archivos en vuelo a la vez dentro de un lote. Pocos: cada uno es una
 * descarga + subida completa, y Google limita por usuario. Con 3 se aprovecha
 * la latencia de los archivos pequeños sin disparar 429.
 */
const FILE_CONCURRENCY = 3;

/** Tope del recorrido para la vista previa, que se calcula en la petición HTTP. */
const PREVIEW_LIMIT = 5_000;

interface ScannedEntry {
  node: TreeNode;
  path: string;
  /** Carpeta de origen que lo contiene; `null` si es un elemento seleccionado. */
  sourceParentId: string | null;
  /** Elemento seleccionado del que cuelga (él mismo si es de primer nivel). */
  topId: string;
}

interface Scan {
  tops: TreeNode[];
  folders: ScannedEntry[];
  files: ScannedEntry[];
  truncated: boolean;
}

type Disposition =
  | { action: 'transfer'; deleteSource: boolean; note: string | null }
  | { action: 'skip'; reason: string };

export type ProgressReporter = (progress: BatchProgress) => void;

/**
 * Transferencias de varios elementos, incluidas carpetas completas.
 *
 * Reutiliza `DriveAggregateService.transfer` para cada archivo, así que cada
 * uno hereda la misma garantía: el original solo se borra tras verificar su
 * copia. Lo que añade este servicio es la estructura: recrear las carpetas en
 * destino, decidir qué no se puede mover y, al final, borrar una carpeta de
 * origen únicamente si ha quedado vacía.
 */
@Injectable()
export class BatchTransferService {
  private readonly logger = new Logger(BatchTransferService.name);

  constructor(
    private readonly clients: DriveClientFactory,
    private readonly drive: DriveService,
    private readonly aggregate: DriveAggregateService,
  ) {}

  /** Qué supondría la transferencia, sin ejecutar nada. */
  async preview(userId: string, dto: TransferPreviewDto): Promise<TransferPreview> {
    this.assertDistinctAccounts(dto.fromAccountId, dto.toAccountId);
    const source = await this.clients.forAccount(userId, dto.fromAccountId);
    const target = await this.clients.forAccount(userId, dto.toAccountId);

    const [scan, quota] = await Promise.all([
      this.scan(source, dto.ids, PREVIEW_LIMIT),
      this.drive.getQuota(target),
    ]);

    const preview: TransferPreview = {
      files: scan.files.length,
      folders: scan.folders.length,
      bytes: 0,
      nativeDocs: 0,
      shortcuts: 0,
      notOwned: 0,
      notExportable: 0,
      truncated: scan.truncated,
      conflicts: [],
      targetFreeBytes: quota.freeBytes,
      fits: true,
    };

    for (const { node } of scan.files) {
      if (node.mimeType === SHORTCUT_MIME_TYPE) preview.shortcuts += 1;
      else if (isGoogleNative(node.mimeType)) {
        if (GOOGLE_NATIVE_EXPORTS[node.mimeType]) preview.nativeDocs += 1;
        else preview.notExportable += 1;
      } else {
        preview.bytes += node.size ?? 0;
        if (!node.ownedByMe) preview.notOwned += 1;
      }
    }
    preview.fits = quota.freeBytes === null || preview.bytes <= quota.freeBytes;

    const parentId = dto.parentId ?? 'root';
    const topFolders = scan.tops.filter((node) => node.isFolder);
    const existing = await Promise.all(
      topFolders.map((folder) => this.drive.findFolderByName(target, parentId, folder.name)),
    );
    preview.conflicts = topFolders
      .filter((_, index) => existing[index] !== null)
      .map((folder) => ({ id: folder.id, name: folder.name }));

    return preview;
  }

  async run(
    userId: string,
    dto: BatchTransferDto,
    report: ProgressReporter = () => undefined,
  ): Promise<BatchTransferResult> {
    const startedAt = Date.now();
    this.assertDistinctAccounts(dto.fromAccountId, dto.toAccountId);
    if (dto.permanentlyDeleteSource && !dto.deleteSource) {
      throw new BadRequestException('permanentlyDeleteSource requiere deleteSource=true');
    }

    const source = await this.clients.forAccount(userId, dto.fromAccountId);
    const target = await this.clients.forAccount(userId, dto.toAccountId);
    const moving = dto.deleteSource === true;
    const permanent = dto.permanentlyDeleteSource === true;
    const baseParent = dto.parentId ?? 'root';
    const explicitParent = new Map(dto.items.map((item) => [item.id, item.parentId]));

    const progress: BatchProgress = {
      phase: 'scanning',
      percent: 0,
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      current: null,
    };
    report({ ...progress });

    const scan = await this.scan(
      source,
      dto.items.map((item) => item.id),
      Number.POSITIVE_INFINITY,
    );

    // ── 1. Estructura de carpetas en destino ────────────────────────────
    // El recorrido es en anchura, así que cada carpeta llega después de su
    // padre y su destino ya está resuelto.
    progress.phase = 'folders';
    report({ ...progress });

    const destOf = new Map<string, string>();
    /** Carpetas creadas en este trabajo: no pueden tener nada previo dentro. */
    const fresh = new Set<string>();
    let foldersCreated = 0;

    for (const folder of scan.folders) {
      const parentDest = this.destinationParent(folder, destOf, explicitParent, baseParent);
      let name = folder.node.name;
      let destId: string | null = null;

      if (!fresh.has(parentDest)) {
        const existing = await this.drive.findFolderByName(target, parentDest, name);
        if (existing) {
          const renameTop = dto.onConflict === 'rename' && folder.sourceParentId === null;
          if (renameTop) name = await this.freeFolderName(target, parentDest, name);
          else destId = existing.id;
        }
      }

      if (!destId) {
        const created = await this.drive.createFolder(target, { name, parentId: parentDest });
        fresh.add(created.id);
        foldersCreated += 1;
        destId = created.id;
      }
      destOf.set(folder.node.id, destId);
    }

    // ── 2. Archivos ─────────────────────────────────────────────────────
    const plan = scan.files.map((entry) => ({
      entry,
      parentDest: this.destinationParent(entry, destOf, explicitParent, baseParent),
      disposition: this.classify(entry.node, moving),
    }));

    progress.phase = 'transferring';
    progress.filesTotal = plan.length;
    progress.bytesTotal = plan.reduce(
      (sum, { entry, disposition }) =>
        disposition.action === 'transfer' ? sum + (entry.node.size ?? 0) : sum,
      0,
    );

    const inFlight = new Map<string, number>();
    let lastReport = 0;
    const tick = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 750) return;
      lastReport = now;
      const partial = [...inFlight.values()].reduce((sum, bytes) => sum + bytes, 0);
      const done = progress.bytesDone + partial;
      const ratio =
        progress.bytesTotal > 0
          ? done / progress.bytesTotal
          : progress.filesTotal > 0
            ? progress.filesDone / progress.filesTotal
            : 1;
      // 99 como máximo hasta terminar: aún queda la limpieza de carpetas.
      report({ ...progress, bytesDone: done, percent: Math.min(99, Math.floor(ratio * 100)) });
    };
    tick(true);

    const outcomes: Array<BatchItemOutcome & { topId: string }> = [];
    const destListings = new Map<string, Promise<Map<string, TreeNode[]>>>();
    const listingOf = (folderId: string) => {
      let listing = destListings.get(folderId);
      if (!listing) {
        listing = this.drive.listChildren(target, folderId).then((nodes) => {
          const byName = new Map<string, TreeNode[]>();
          for (const node of nodes) byName.set(node.name, [...(byName.get(node.name) ?? []), node]);
          return byName;
        });
        destListings.set(folderId, listing);
      }
      return listing;
    };

    await runPool(plan, FILE_CONCURRENCY, async ({ entry, parentDest, disposition }) => {
      const { node } = entry;
      const outcome: BatchItemOutcome & { topId: string } = {
        fileId: node.id,
        name: node.name,
        path: entry.path,
        size: node.size,
        status: 'failed',
        reason: null,
        targetParentId: parentDest,
        uploadedId: null,
        topId: entry.topId,
      };
      progress.current = entry.path;

      try {
        if (disposition.action === 'skip') {
          outcome.status = 'skipped';
          outcome.reason = disposition.reason;
          return;
        }

        // En carpetas que ya existían puede haber una copia de un intento
        // anterior: si el md5 coincide, repetir la subida solo duplicaría.
        const twin = fresh.has(parentDest) ? undefined : findTwin(node, await listingOf(parentDest));

        if (twin) {
          if (disposition.deleteSource) {
            await this.drive.deleteFile(source, node.id, permanent);
          }
          outcome.status = disposition.deleteSource ? 'moved' : 'already';
          outcome.reason = node.md5Checksum
            ? 'Ya había una copia idéntica en el destino'
            : 'Ya había una copia convertida posterior a la última edición';
          outcome.uploadedId = twin.id;
          progress.bytesDone += node.size ?? 0;
          return;
        }

        const request = {
          from: { accountId: dto.fromAccountId, fileId: node.id },
          to: { accountId: dto.toAccountId, parentId: parentDest },
          deleteSource: disposition.deleteSource,
          permanentlyDeleteSource: disposition.deleteSource && permanent,
        } as TransferDto;

        const result = await this.aggregate.transfer(userId, request, {
          onProgress: (percent) => {
            inFlight.set(node.id, ((node.size ?? 0) * percent) / 100);
            tick();
          },
        });

        outcome.status = disposition.deleteSource ? 'moved' : 'copied';
        outcome.reason = disposition.note;
        outcome.uploadedId = result.uploaded.id;
        progress.bytesDone += node.size ?? 0;
      } catch (error) {
        // Un archivo que falla no detiene el lote: se anota y se sigue. El
        // original sigue intacto (transfer() solo borra tras verificar).
        outcome.status = 'failed';
        outcome.reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Lote: "${entry.path}" falló: ${outcome.reason}`);
      } finally {
        inFlight.delete(node.id);
        progress.filesDone += 1;
        outcomes.push(outcome);
        tick(true);
      }
    });

    // ── 3. Carpetas de origen ───────────────────────────────────────────
    const removedSourceFolders: string[] = [];
    const keptSourceFolders: Array<{ name: string; reason: string }> = [];

    if (moving) {
      progress.phase = 'cleaning';
      progress.current = null;
      tick(true);

      for (const top of scan.tops.filter((node) => node.isFolder)) {
        const pending = outcomes.filter((o) => o.topId === top.id && o.status !== 'moved').length;
        if (pending > 0) {
          keptSourceFolders.push({
            name: top.name,
            reason: `${pending} elemento${pending === 1 ? '' : 's'} sigue${pending === 1 ? '' : 'n'} en el origen`,
          });
          continue;
        }
        try {
          // Se vuelve a mirar el origen: alguien pudo añadir algo mientras
          // tanto, y borrar la carpeta se lo llevaría por delante.
          const remaining = await this.scan(source, [top.id], 1);
          if (remaining.files.length > 0) {
            keptSourceFolders.push({ name: top.name, reason: 'Contiene archivos nuevos' });
            continue;
          }
          await this.drive.deleteFile(source, top.id, permanent);
          removedSourceFolders.push(top.name);
        } catch (error) {
          keptSourceFolders.push({
            name: top.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const counts: Record<BatchItemStatus, number> = {
      moved: 0,
      copied: 0,
      already: 0,
      skipped: 0,
      failed: 0,
    };
    for (const outcome of outcomes) counts[outcome.status] += 1;

    this.logger.log(
      `Lote de ${source.account.email} a ${target.account.email}: ` +
        Object.entries(counts)
          .map(([status, count]) => `${status}=${count}`)
          .join(' '),
    );

    // El orden de llegada depende de la concurrencia; por ruta es estable.
    const items = outcomes
      .map(({ topId: _topId, ...outcome }) => outcome)
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      kind: 'batch',
      from: toAccountRef(source.account),
      to: toAccountRef(target.account),
      items,
      counts,
      bytesTransferred: progress.bytesDone,
      foldersCreated,
      removedSourceFolders,
      keptSourceFolders,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Recorre en anchura los elementos seleccionados. `limit` corta cuando se
   * han visto tantos archivos (la vista previa no puede tardar minutos).
   */
  private async scan(ctx: DriveContext, ids: string[], limit: number): Promise<Scan> {
    const scan: Scan = { tops: [], folders: [], files: [], truncated: false };
    const queue: ScannedEntry[] = [];

    for (const id of [...new Set(ids)]) {
      const node = await this.drive.getTreeNode(ctx, id);
      scan.tops.push(node);
      const entry = { node, path: node.name, sourceParentId: null, topId: node.id };
      if (node.isFolder) {
        scan.folders.push(entry);
        queue.push(entry);
      } else {
        scan.files.push(entry);
      }
    }

    while (queue.length > 0) {
      if (scan.files.length >= limit) {
        scan.truncated = true;
        break;
      }
      const folder = queue.shift() as ScannedEntry;
      for (const node of await this.drive.listChildren(ctx, folder.node.id)) {
        const entry = {
          node,
          path: `${folder.path}/${node.name}`,
          sourceParentId: folder.node.id,
          topId: folder.topId,
        };
        if (node.isFolder) {
          scan.folders.push(entry);
          queue.push(entry);
        } else {
          scan.files.push(entry);
        }
      }
    }

    return scan;
  }

  private classify(node: TreeNode, moving: boolean): Disposition {
    if (node.mimeType === SHORTCUT_MIME_TYPE) {
      return { action: 'skip', reason: 'Acceso directo: no tiene contenido propio' };
    }
    if (isGoogleNative(node.mimeType)) {
      if (!GOOGLE_NATIVE_EXPORTS[node.mimeType]) {
        return { action: 'skip', reason: 'Tipo de documento de Google que no se puede exportar' };
      }
      // Invariante: la copia es una conversión de formato, no un duplicado
      // verificable, así que el original nunca se borra.
      return {
        action: 'transfer',
        deleteSource: false,
        note: moving ? 'Documento de Google: se copia convertido y el original se conserva' : null,
      };
    }
    if (moving && !node.ownedByMe) {
      return {
        action: 'skip',
        reason: 'De otro propietario: no ocupa tu cuota y no se puede borrar el original',
      };
    }
    return { action: 'transfer', deleteSource: moving, note: null };
  }

  private destinationParent(
    entry: ScannedEntry,
    destOf: Map<string, string>,
    explicitParent: Map<string, string | undefined>,
    baseParent: string,
  ): string {
    if (entry.sourceParentId === null) {
      return explicitParent.get(entry.node.id) ?? baseParent;
    }
    const parent = destOf.get(entry.sourceParentId);
    if (!parent) {
      throw new Error(`Carpeta destino sin resolver para "${entry.path}"`);
    }
    return parent;
  }

  /** "Facturas (2)", "Facturas (3)"… el primero que no exista. */
  private async freeFolderName(ctx: DriveContext, parentId: string, name: string): Promise<string> {
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${name} (${n})`;
      if (!(await this.drive.findFolderByName(ctx, parentId, candidate))) return candidate;
    }
    return `${name} (${Date.now()})`;
  }

  private assertDistinctAccounts(from: string, to: string): void {
    if (from === to) {
      throw new BadRequestException(
        'Origen y destino son la misma cuenta: para eso usa «Mover» dentro de la cuenta.',
      );
    }
  }
}

/**
 * Copia ya presente en el destino que hace innecesario volver a subir `node`.
 *
 * Un archivo normal se reconoce por md5. Un documento de Google no tiene md5 y
 * cada exportación produce bytes distintos, así que se reconoce por el nombre
 * de su conversión ("Acta.docx") y por fecha: si la copia se creó después de
 * la última edición del original, sigue al día. El original nunca se borra en
 * ese caso (classify ya fija deleteSource=false), así que no hay riesgo de
 * perder nada por fiarse de la fecha.
 */
function findTwin(node: TreeNode, listing: Map<string, TreeNode[]>): TreeNode | undefined {
  if (node.md5Checksum) {
    return listing.get(node.name)?.find((candidate) => candidate.md5Checksum === node.md5Checksum);
  }
  const target = GOOGLE_NATIVE_EXPORTS[node.mimeType];
  if (!target || !node.modifiedTime) return undefined;
  const editedAt = Date.parse(node.modifiedTime);
  return listing
    .get(`${node.name}.${target.extension}`)
    ?.find(
      (candidate) =>
        candidate.mimeType === target.mimeType &&
        candidate.createdTime !== null &&
        Date.parse(candidate.createdTime) >= editedAt,
    );
}

/** Ejecuta `worker` sobre `items` con, como mucho, `size` en paralelo. */
async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

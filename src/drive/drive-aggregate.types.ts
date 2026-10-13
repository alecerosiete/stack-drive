import { AccountRef, DriveFileView, StorageQuotaView } from './drive.types';

/**
 * Fallo de UNA cuenta en una operación agregada. Las vistas multi-cuenta son
 * tolerantes a fallos parciales: que una cuenta necesite reautorización no
 * debe dejar al usuario sin ver las otras cuatro.
 */
export interface AccountFailure {
  account: AccountRef;
  code: string;
  message: string;
}

export interface AggregateResult<T> {
  results: T[];
  failures: AccountFailure[];
}

export interface AggregateQuota extends AggregateResult<StorageQuotaView> {
  totals: {
    limit: number | null;
    usage: number;
    freeBytes: number | null;
  };
  /** Cuenta con más espacio libre: destino sugerido para la próxima subida. */
  recommendedAccountId: string | null;
}

export interface TransferResult {
  source: { account: AccountRef; fileId: string; name: string; size: number | null };
  uploaded: DriveFileView;
  /** `true` si se comprobó md5 o tamaño de la copia frente al original. */
  verified: boolean;
  verification: 'md5' | 'size' | 'none';
  /** `true` si el original se envió a la papelera tras verificar. */
  sourceTrashed: boolean;
  /** `true` si el original se borró de forma permanente (`permanentlyDeleteSource`). */
  sourceDeleted: boolean;
  durationMs: number;
}

export interface PlannedMove {
  file: { id: string; name: string; mimeType: string; size: number };
  from: AccountRef;
  to: AccountRef;
  bytes: number;
}

export interface RebalancePlan {
  /** Fracción de cuota a partir de la cual se considera presión (0-1). */
  threshold: number;
  quotas: StorageQuotaView[];
  /** Cuentas por encima del umbral, de mayor a menor ocupación. */
  underPressure: Array<{ account: AccountRef; usedPercent: number; bytesToFree: number }>;
  moves: PlannedMove[];
  /** Bytes que liberaría el plan completo en las cuentas presionadas. */
  freedBytes: number;
  /** Bytes que NO se pueden liberar (no hay destino con hueco suficiente). */
  unresolvedBytes: number;
  notes: string[];
  failures: AccountFailure[];
}

/**
 * Qué pasó con cada archivo de un lote:
 *  - `moved`: copiado, verificado y original borrado.
 *  - `copied`: copiado; el original se conserva (copia pedida o documento de Google).
 *  - `already`: ya había una copia idéntica (mismo md5) en destino.
 *  - `skipped`: no se transfiere (acceso directo, de otro propietario…).
 *  - `failed`: error; se puede reintentar con su `targetParentId`.
 */
export type BatchItemStatus = 'moved' | 'copied' | 'already' | 'skipped' | 'failed';

export interface BatchItemOutcome {
  fileId: string;
  name: string;
  /** Ruta relativa al elemento seleccionado: `Facturas 2026/enero/f1.pdf`. */
  path: string;
  size: number | null;
  status: BatchItemStatus;
  reason: string | null;
  /** Carpeta destino que le correspondía; permite reintentar solo este archivo. */
  targetParentId: string;
  uploadedId: string | null;
}

export interface BatchProgress {
  phase: 'scanning' | 'folders' | 'transferring' | 'cleaning';
  percent: number;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  current: string | null;
}

export interface BatchTransferResult {
  kind: 'batch';
  from: AccountRef;
  to: AccountRef;
  items: BatchItemOutcome[];
  counts: Record<BatchItemStatus, number>;
  bytesTransferred: number;
  foldersCreated: number;
  /** Carpetas de origen eliminadas al quedar vacías tras moverlo todo. */
  removedSourceFolders: string[];
  /** Carpetas de origen que se conservan, y por qué. */
  keptSourceFolders: Array<{ name: string; reason: string }>;
  durationMs: number;
}

export interface TransferPreview {
  files: number;
  folders: number;
  /** Bytes de los archivos con contenido propio (sin documentos de Google). */
  bytes: number;
  nativeDocs: number;
  shortcuts: number;
  /** Archivos de otros propietarios: se copian, pero al mover se saltan. */
  notOwned: number;
  notExportable: number;
  /** El recorrido se detuvo en el límite: las cifras son un mínimo. */
  truncated: boolean;
  /** Carpetas seleccionadas que ya existen con ese nombre en el destino. */
  conflicts: Array<{ id: string; name: string }>;
  targetFreeBytes: number | null;
  fits: boolean;
}

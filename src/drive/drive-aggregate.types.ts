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

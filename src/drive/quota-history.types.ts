import { AccountRef } from './drive.types';

/** Una medición del vigilante de cuota, en bytes. */
export interface QuotaHistoryPoint {
  capturedAt: string;
  /** NULL en cuentas con almacenamiento ilimitado. */
  limit: number | null;
  usage: number;
  usageInDrive: number;
  usageInDriveTrash: number;
  usedPercent: number | null;
}

export interface QuotaHistory {
  from: string;
  to: string;
  /**
   * Sin el vigilante (`QUOTA_WATCH_ENABLED`) no se registran muestras: el
   * cliente lo necesita para distinguir "sin cambios" de "nadie mide".
   */
  watchEnabled: boolean;
  /** Todas las cuentas del usuario, también las que aún no tienen muestras. */
  accounts: Array<{ account: AccountRef; points: QuotaHistoryPoint[] }>;
}

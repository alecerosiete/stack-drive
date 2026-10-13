/**
 * Espejo de las vistas públicas de la API (`src/**\/*.types.ts` y
 * `account.dto.ts` del backend). Solo lo que realmente sale por la red.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface Profile {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  linkedAccounts: number;
}

export type AccountStatus = 'ACTIVE' | 'NEEDS_REAUTH' | 'REVOKED';

export interface GoogleAccount {
  id: string;
  email: string;
  alias: string | null;
  picture: string | null;
  status: AccountStatus;
  statusError: string | null;
  scopes: string[];
  linkedAt: string;
  lastUsedAt: string | null;
  needsReauth: boolean;
}

export interface AccountRef {
  id: string;
  email: string;
  alias: string | null;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size: number | null;
  parents: string[];
  createdTime: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  webContentLink: string | null;
  iconLink: string | null;
  thumbnailLink: string | null;
  trashed: boolean;
  md5Checksum: string | null;
  account: AccountRef;
}

export interface DriveFilePage {
  files: DriveFile[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
  account: AccountRef;
}

export interface StorageQuota {
  account: AccountRef;
  limit: number | null;
  usage: number;
  usageInDrive: number;
  usageInDriveTrash: number;
  freeBytes: number | null;
  usedPercent: number | null;
}

export interface AccountFailure {
  account: AccountRef;
  code: string;
  message: string;
}

export interface AggregateResult<T> {
  results: T[];
  failures: AccountFailure[];
}

export interface AggregateQuota extends AggregateResult<StorageQuota> {
  totals: { limit: number | null; usage: number; freeBytes: number | null };
  recommendedAccountId: string | null;
}

export interface PlannedMove {
  file: { id: string; name: string; mimeType: string; size: number };
  from: AccountRef;
  to: AccountRef;
  bytes: number;
}

export interface RebalancePlan {
  threshold: number;
  quotas: StorageQuota[];
  underPressure: Array<{ account: AccountRef; usedPercent: number; bytesToFree: number }>;
  moves: PlannedMove[];
  freedBytes: number;
  unresolvedBytes: number;
  notes: string[];
  failures: AccountFailure[];
}

export interface TransferResult {
  source: { account: AccountRef; fileId: string; name: string; size: number | null };
  uploaded: DriveFile;
  verified: boolean;
  verification: 'md5' | 'size' | 'none';
  sourceTrashed: boolean;
  durationMs: number;
}

export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'prioritized' | 'waiting-children' | 'unknown';

export interface TransferRequest {
  from: { accountId: string; fileId: string };
  to: { accountId: string; parentId?: string; name?: string };
  deleteSource?: boolean;
}

export interface TransferJob {
  jobId: string;
  state: JobState;
  progress: number;
  attemptsMade: number;
  createdAt: string | null;
  finishedAt: string | null;
  result: TransferResult | null;
  error: string | null;
  /** Qué se pidió transferir; disponible aunque el job no haya terminado. */
  request?: TransferRequest;
}

export interface LinkUrl {
  authUrl: string;
  state: string;
  expiresAt: string;
}

import { Readable } from 'node:stream';
import { drive_v3 } from 'googleapis';
import { GoogleAccount } from '@prisma/client';

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut';

/** Campos que pedimos a la Drive API. Pedir solo lo necesario reduce latencia. */
export const FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'parents',
  'createdTime',
  'modifiedTime',
  'webViewLink',
  'webContentLink',
  'iconLink',
  'thumbnailLink',
  'trashed',
  'md5Checksum',
  'shortcutDetails',
].join(',');

/** Campos mínimos para recorrer un árbol de carpetas (transferencias por lotes). */
export const TREE_FIELDS = 'id,name,mimeType,size,md5Checksum,ownedByMe,createdTime,modifiedTime';

export interface TreeNode {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size: number | null;
  md5Checksum: string | null;
  /** Solo lo propio se puede borrar y solo lo propio consume TU cuota. */
  ownedByMe: boolean;
  /**
   * Fechas ISO. Sirven para reconocer la copia convertida de un documento de
   * Google: no tiene md5 comparable, pero si se creó después de la última
   * edición del original, sigue al día.
   */
  createdTime: string | null;
  modifiedTime: string | null;
}

export function toTreeNode(file: drive_v3.Schema$File): TreeNode {
  return {
    id: file.id ?? '',
    name: file.name ?? '(sin nombre)',
    mimeType: file.mimeType ?? 'application/octet-stream',
    isFolder: file.mimeType === FOLDER_MIME_TYPE,
    size: file.size !== undefined && file.size !== null ? Number(file.size) : null,
    md5Checksum: file.md5Checksum ?? null,
    // Ausente en unidades compartidas, donde el propietario es la unidad: ahí
    // el usuario sí puede borrar si tiene permisos, así que no lo bloqueamos.
    ownedByMe: file.ownedByMe ?? true,
    createdTime: file.createdTime ?? null,
    modifiedTime: file.modifiedTime ?? null,
  };
}

/** Referencia mínima a la cuenta origen: imprescindible en vistas unificadas. */
export interface AccountRef {
  id: string;
  email: string;
  alias: string | null;
}

export interface DriveFileView {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  /** Bytes. `null` en documentos nativos de Google, que no ocupan cuota. */
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
  files: DriveFileView[];
  nextPageToken: string | null;
  /** Google avisa de que la búsqueda pudo no abarcar todo el corpus. */
  incompleteSearch: boolean;
  account: AccountRef;
}

export interface DriveDownload {
  stream: Readable;
  filename: string;
  mimeType: string;
  size: number | null;
}

export interface StorageQuotaView {
  account: AccountRef;
  /** Bytes totales. `null` en cuentas con almacenamiento ilimitado. */
  limit: number | null;
  usage: number;
  /** Incluye la papelera: `usageInDriveTrash` es un subconjunto de esta cifra. */
  usageInDrive: number;
  usageInDriveTrash: number;
  /**
   * Gmail + Google Fotos juntos. La Drive API solo publica el total de la
   * cuenta y el de Drive; el desglose por servicio que muestra Google One no
   * está expuesto, así que lo que no es Drive es lo único que se puede derivar.
   */
  usageOutsideDrive: number;
  freeBytes: number | null;
  usedPercent: number | null;
}

export function toAccountRef(account: GoogleAccount): AccountRef {
  return { id: account.id, email: account.email, alias: account.alias };
}

export function toFileView(file: drive_v3.Schema$File, account: GoogleAccount): DriveFileView {
  return {
    id: file.id ?? '',
    name: file.name ?? '(sin nombre)',
    mimeType: file.mimeType ?? 'application/octet-stream',
    isFolder: file.mimeType === FOLDER_MIME_TYPE,
    size: file.size !== undefined && file.size !== null ? Number(file.size) : null,
    parents: file.parents ?? [],
    createdTime: file.createdTime ?? null,
    modifiedTime: file.modifiedTime ?? null,
    webViewLink: file.webViewLink ?? null,
    webContentLink: file.webContentLink ?? null,
    iconLink: file.iconLink ?? null,
    thumbnailLink: file.thumbnailLink ?? null,
    trashed: file.trashed ?? false,
    md5Checksum: file.md5Checksum ?? null,
    account: toAccountRef(account),
  };
}

/**
 * Los documentos nativos de Google (Docs, Sheets, Slides) no tienen bytes
 * descargables: hay que exportarlos a un formato concreto.
 */
export const GOOGLE_NATIVE_EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx',
  },
  'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: 'png' },
  'application/vnd.google-apps.script': {
    mimeType: 'application/vnd.google-apps.script+json',
    extension: 'json',
  },
};

export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.');
}

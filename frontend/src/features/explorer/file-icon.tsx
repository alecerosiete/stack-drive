import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Link2,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import type { DriveFile } from '../../api/types';

interface Kind {
  icon: LucideIcon;
  color: string;
  label: string;
}

const KINDS: Array<[RegExp, Kind]> = [
  [/folder$/, { icon: Folder, color: '#e8c547', label: 'Carpeta' }],
  [/shortcut$/, { icon: Link2, color: '#9a9284', label: 'Acceso directo' }],
  [/google-apps\.document|msword|wordprocessing|^text\/|pdf/, { icon: FileText, color: '#4fa3e0', label: 'Documento' }],
  [/spreadsheet|excel|csv/, { icon: FileSpreadsheet, color: '#4cc38a', label: 'Hoja de cálculo' }],
  [/presentation|powerpoint/, { icon: Presentation, color: '#ff7a3d', label: 'Presentación' }],
  [/^image\/|drawing/, { icon: FileImage, color: '#e25d8a', label: 'Imagen' }],
  [/^video\//, { icon: FileVideo, color: '#c77dff', label: 'Vídeo' }],
  [/^audio\//, { icon: FileAudio, color: '#7c8cf8', label: 'Audio' }],
  [/zip|compressed|tar|rar|7z|gzip/, { icon: FileArchive, color: '#b7791f', label: 'Archivo comprimido' }],
  [/json|javascript|xml|html|script|x-sh|typescript/, { icon: FileCode, color: '#3fb8a6', label: 'Código' }],
];

const FALLBACK: Kind = { icon: File, color: '#9a9284', label: 'Archivo' };

export function fileKind(file: Pick<DriveFile, 'mimeType'>): Kind {
  return KINDS.find(([pattern]) => pattern.test(file.mimeType))?.[1] ?? FALLBACK;
}

export function FileIcon({ file, className = 'size-5' }: { file: Pick<DriveFile, 'mimeType'>; className?: string }) {
  const { icon: Icon, color } = fileKind(file);
  return <Icon className={className} style={{ color }} strokeWidth={1.75} aria-hidden />;
}

export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.') && !mimeType.endsWith('folder');
}

import { DriveFileView } from './drive.types';

/**
 * Lo que el navegador ve de una subida reanudable. Nunca incluye la URL de la
 * sesión de Google: esa se queda en el servidor.
 */
export interface UploadSessionView {
  id: string;
  accountId: string;
  name: string;
  size: number;
  /** Bytes que Google ya confirmó: el siguiente bloque empieza aquí. */
  offset: number;
  /** Tamaño de bloque que debe usar el cliente (múltiplo de 256 KiB). */
  chunkSize: number;
  expiresAt: string;
  /** Presente cuando la subida terminó. */
  file?: DriveFileView;
}

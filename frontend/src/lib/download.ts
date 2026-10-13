import { rawRequest } from './api';

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    createWritable: () => Promise<WritableStream<Uint8Array>>;
  }>;
}

/**
 * Descarga a través del proxy de la API (necesita el Bearer, así que un
 * `<a href>` directo no sirve).
 *
 * Donde el navegador lo permite (Chromium) los bytes van en streaming
 * directo al archivo elegido, sin acumular el archivo en memoria: mismo
 * principio que el backend aplica de extremo a extremo. En el resto se cae
 * a un Blob, que sí ocupa memoria del navegador mientras dura la descarga.
 */
export async function downloadFile(accountId: string, fileId: string, filename: string): Promise<void> {
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;

  if (picker) {
    let handle;
    try {
      handle = await picker({ suggestedName: filename });
    } catch (error) {
      // El usuario cerró el diálogo de guardado: no es un error.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      throw error;
    }
    const response = await rawRequest(`/drive/${accountId}/files/${fileId}/download`);
    if (!response.body) throw new Error('La respuesta no trae contenido');
    await response.body.pipeTo(await handle.createWritable());
    return;
  }

  const response = await rawRequest(`/drive/${accountId}/files/${fileId}/download`);
  const url = URL.createObjectURL(await response.blob());
  const anchor = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

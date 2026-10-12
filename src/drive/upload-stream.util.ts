import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import Busboy from 'busboy';
import { Request } from 'express';
import { Readable } from 'node:stream';

export interface IncomingFile {
  stream: Readable;
  filename: string;
  mimeType: string;
}

export interface UploadHandlerContext {
  /** Campos del formulario que llegaron ANTES de la parte del archivo. */
  fields: Record<string, string>;
}

export type UploadHandler<T> = (file: IncomingFile, context: UploadHandlerContext) => Promise<T>;

const DEFAULT_MIME = 'application/octet-stream';

/**
 * Entrega el cuerpo de la petición a `handler` como stream, sin bufferizarlo
 * en memoria ni escribirlo a disco.
 *
 * Es lo que permite subir un archivo de 2 GB a Google Drive con un consumo de
 * memoria constante: los bytes que llegan del cliente se reenvían a Google a
 * medida que se reciben. La contrapartida es que la petición a Google se abre
 * antes de conocer el tamaño total, así que los metadatos de destino
 * (`parentId`, `name`) se leen de la query string.
 *
 * Admite dos formatos de subida:
 *
 *  - `multipart/form-data` con una única parte de archivo (formularios web).
 *  - Cuerpo binario directo con `X-File-Name` (clientes programáticos).
 */
export async function withUploadStream<T>(
  req: Request,
  maxBytes: number,
  handler: UploadHandler<T>,
): Promise<T> {
  const contentType = req.headers['content-type'] ?? '';

  if (contentType.includes('multipart/form-data')) {
    return handleMultipart(req, maxBytes, handler);
  }

  return handleRawBody(req, maxBytes, handler);
}

function handleMultipart<T>(req: Request, maxBytes: number, handler: UploadHandler<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: maxBytes, fields: 20, fieldSize: 8192 },
    });

    const fields: Record<string, string> = {};
    let fileSeen = false;
    let sizeExceeded = false;
    let settled = false;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      req.unpipe(busboy);
      action();
    };

    const fail = (error: unknown): void =>
      settle(() =>
        reject(
          sizeExceeded
            ? new PayloadTooLargeException(
                `El archivo supera el límite de ${formatBytes(maxBytes)} configurado en UPLOAD_MAX_BYTES`,
              )
            : error,
        ),
      );

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (_fieldName, stream, info) => {
      if (fileSeen) {
        stream.resume(); // descartamos partes extra sin bloquear el parser
        return;
      }
      fileSeen = true;

      stream.on('limit', () => {
        sizeExceeded = true;
        // Destruir el stream con error aborta también la subida a Google, en
        // lugar de dejar que termine con un archivo truncado.
        stream.destroy(new Error('upload exceeded UPLOAD_MAX_BYTES'));
      });

      // Una parte multipart puede venir sin nombre de archivo; en ese caso el
      // nombre definitivo lo pone la query (`?name=`) en el servicio de Drive.
      handler(
        {
          stream,
          filename: info.filename?.trim() || 'archivo-sin-nombre',
          mimeType: info.mimeType || DEFAULT_MIME,
        },
        { fields },
      )
        .then((result) => settle(() => resolve(result)))
        .catch(fail);
    });

    busboy.on('filesLimit', () =>
      fail(new BadRequestException('Solo se admite un archivo por petición')),
    );
    busboy.on('error', fail);
    busboy.on('close', () => {
      if (!fileSeen) {
        fail(new BadRequestException('La petición multipart no contenía ninguna parte de archivo'));
      }
    });

    req.pipe(busboy);
  });
}

function handleRawBody<T>(req: Request, maxBytes: number, handler: UploadHandler<T>): Promise<T> {
  const filename = headerValue(req, 'x-file-name') ?? (req.query.name as string | undefined);
  if (!filename) {
    throw new BadRequestException(
      'Para subir un cuerpo binario directo indica el nombre en la cabecera X-File-Name ' +
        'o usa multipart/form-data',
    );
  }

  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (declaredLength > maxBytes) {
    throw new PayloadTooLargeException(
      `El archivo supera el límite de ${formatBytes(maxBytes)} configurado en UPLOAD_MAX_BYTES`,
    );
  }

  return handler(
    {
      stream: req,
      filename,
      mimeType: (req.headers['content-type'] as string | undefined) ?? DEFAULT_MIME,
    },
    { fields: {} },
  );
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

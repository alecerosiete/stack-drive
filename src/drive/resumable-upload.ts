import { Logger } from '@nestjs/common';
import { drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';
import { isRetryableGoogleError, normalizeGoogleError } from '../common/google-error.util';
import { withRetry } from '../common/retry';

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

/** Lo único que se necesita de un `OAuth2Client`: peticiones autorizadas. */
export interface UploadHttp {
  request<T = unknown>(options: {
    url: string;
    method: 'POST' | 'PUT' | 'DELETE';
    params?: Record<string, string | boolean>;
    headers?: Record<string, string>;
    data?: unknown;
    timeout?: number;
    responseType?: 'json';
    validateStatus?: (status: number) => boolean;
  }): Promise<{
    status: number;
    data: T;
    headers: { get(name: string): string | null };
  }>;
}

/** Lo que Google necesita para abrir una sesión de subida. */
export interface UploadTarget {
  name: string;
  mimeType: string;
  parentId: string;
  /** Tamaño exacto: el protocolo lo exige para saber cuándo está completo. */
  size: number;
  fields: string;
}

export interface ResumableUploadParams extends UploadTarget {
  /**
   * Cliente autorizado de la cuenta destino. Se pide de nuevo antes de cada
   * reanudación: una subida de varios GB puede durar más que el access_token
   * con el que empezó.
   */
  authorize: (opts: { stale: boolean }) => Promise<UploadHttp>;
  /** Abre el origen a partir del byte `offset` (inclusive). */
  openSource: (offset: number) => Promise<Readable>;
  maxResumes: number;
  baseDelayMs: number;
  logger?: Logger;
  /** Para los tests: sustituye la espera entre reanudaciones. */
  sleep?: (ms: number) => Promise<void>;
}

/** Estado de la sesión según Google: terminada, o cuántos bytes confirmó. */
export type SessionStatus = { file: drive_v3.Schema$File } | { offset: number };

/**
 * Sube un archivo con el protocolo *resumable* de la Drive API y, si la
 * conexión se corta, continúa desde el último byte que Google confirmó en vez
 * de empezar de cero.
 *
 * Se envía TODO lo pendiente en un único PUT en streaming (el protocolo lo
 * admite si se conoce el tamaño total), en lugar de trocearlo en bloques de
 * 256 KiB: trocear obligaría a tener cada bloque entero en memoria para poder
 * reenviarlo. Aquí no hace falta, porque el origen se puede volver a abrir
 * desde cualquier offset (`openSource`), así que nada se bufferiza.
 */
export async function resumableUpload(
  params: ResumableUploadParams,
): Promise<drive_v3.Schema$File> {
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let http = await params.authorize({ stale: false });
  const sessionUrl = await startSession(http, params);

  let offset = 0;
  // Solo cuentan los intentos seguidos SIN avance: un archivo de varios GB en
  // una red inestable puede cortarse muchas veces y aun así llegar, siempre
  // que cada intento confirme bytes nuevos (y el offset no crece sin límite).
  let stalled = 0;
  for (;;) {
    // Abrir el origen queda fuera del try: sus fallos ya los reintenta quien
    // lo abre, y no son un corte de la subida. Un corte de la descarga A MITAD
    // sí llega como fallo del PUT, porque aborta su cuerpo.
    const body = await params.openSource(offset);
    try {
      return await send(http, sessionUrl, offset, body, params.size);
    } catch (error) {
      if (stalled >= params.maxResumes || !isResumable(error)) throw error;

      const { status, message } = normalizeGoogleError(error);
      await sleep(params.baseDelayMs * 2 ** stalled + Math.random() * params.baseDelayMs);
      http = await params.authorize({ stale: status === 401 });

      const state = await withRetry(() => querySession(http, sessionUrl, params.size), {
        retries: params.maxResumes,
        baseDelayMs: params.baseDelayMs,
        operation: `estado de la subida de "${params.name}"`,
        logger: params.logger,
      });
      // El corte pudo llegar justo después de que Google recibiera el último
      // byte: en ese caso la subida ya está completa y no hay nada que reenviar.
      if ('file' in state) return state.file;

      stalled = state.offset > offset ? 0 : stalled + 1;
      params.logger?.warn(
        `Subida de "${params.name}" interrumpida (status=${status ?? 'n/a'}: ${message}). ` +
          `Se reanuda desde ${state.offset}/${params.size} bytes` +
          (stalled > 0 ? ` (sin avance: ${stalled}/${params.maxResumes})` : ''),
      );
      offset = state.offset;
    }
  }
}

export async function startSession(http: UploadHttp, params: UploadTarget): Promise<string> {
  const response = await http.request({
    url: UPLOAD_URL,
    method: 'POST',
    // `fields` y `supportsAllDrives` se fijan al abrir la sesión y se aplican
    // a la respuesta final, la del último PUT.
    params: {
      uploadType: 'resumable',
      supportsAllDrives: true,
      fields: params.fields,
    },
    headers: {
      'X-Upload-Content-Type': params.mimeType,
      'X-Upload-Content-Length': String(params.size),
    },
    data: {
      name: params.name,
      parents: [params.parentId],
      mimeType: params.mimeType,
    },
  });
  const location = response.headers.get('location');
  if (!location) {
    throw new Error('Google no devolvió la URL de la sesión de subida');
  }
  return location;
}

async function send(
  http: UploadHttp,
  sessionUrl: string,
  offset: number,
  body: Readable,
  size: number,
): Promise<drive_v3.Schema$File> {
  try {
    const response = await http.request<drive_v3.Schema$File>({
      url: sessionUrl,
      method: 'PUT',
      headers: {
        'Content-Length': String(size - offset),
        'Content-Range': `bytes ${offset}-${size - 1}/${size}`,
      },
      data: body,
      responseType: 'json',
      // Sin timeout: un archivo grande tarda lo que tarde; los cortes reales
      // llegan como error de red.
      timeout: 0,
    });
    return response.data;
  } finally {
    // Si el PUT falló, la descarga del origen sigue abierta: hay que cerrarla
    // o queda una conexión viva por cada reanudación.
    body.destroy();
  }
}

/** Pregunta a Google cuántos bytes tiene de la sesión (PUT vacío). */
export async function querySession(
  http: UploadHttp,
  sessionUrl: string,
  size: number,
): Promise<SessionStatus> {
  const response = await http.request<drive_v3.Schema$File>({
    url: sessionUrl,
    method: 'PUT',
    headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
    responseType: 'json',
    // 308 "Resume Incomplete" es la respuesta normal mientras falten bytes.
    validateStatus: (status) => status === 308 || (status >= 200 && status < 300),
  });
  return toStatus(response);
}

/**
 * Envía un bloque `[start, end]` (inclusivos) de la sesión. A diferencia de
 * `resumableUpload`, quien llama no puede volver a abrir el origen: el bloque
 * viene del navegador, así que un corte no se reintenta aquí, se devuelve y
 * el cliente reenvía desde lo que Google confirme (`querySession`).
 *
 * Google exige que todo bloque salvo el último mida un múltiplo de 256 KiB;
 * se valida antes de llegar aquí.
 */
export async function sendChunk(
  http: UploadHttp,
  sessionUrl: string,
  range: { start: number; end: number; size: number },
  body: Readable,
): Promise<SessionStatus> {
  const response = await http.request<drive_v3.Schema$File>({
    url: sessionUrl,
    method: 'PUT',
    headers: {
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${range.size}`,
    },
    data: body,
    responseType: 'json',
    timeout: 0,
    validateStatus: (status) => status === 308 || (status >= 200 && status < 300),
  });
  return toStatus(response);
}

/**
 * Cancela la sesión en Google. Responde 499 si la cancela y 404 si ya no
 * existía; ambos significan lo mismo para quien llama.
 */
export async function cancelSession(http: UploadHttp, sessionUrl: string): Promise<void> {
  await http.request({
    url: sessionUrl,
    method: 'DELETE',
    validateStatus: (status) => status === 499 || status === 404 || (status >= 200 && status < 300),
  });
}

function toStatus(response: {
  status: number;
  data: drive_v3.Schema$File;
  headers: { get(name: string): string | null };
}): SessionStatus {
  if (response.status !== 308) return { file: response.data };

  // `Range: bytes=0-N` → confirmados N+1 bytes. Sin cabecera, ninguno.
  const range = response.headers.get('range');
  const match = range ? /bytes=0-(\d+)/.exec(range) : null;
  return { offset: match ? Number(match[1]) + 1 : 0 };
}

/**
 * Un corte de red o un fallo transitorio de Google se puede reanudar; un 401
 * también, con un token nuevo. Un 404/410 significa que la sesión caducó
 * (duran una semana) y cualquier otro 4xx (cuota llena, permisos) no lo
 * arregla reintentar.
 */
export function isResumable(error: unknown): boolean {
  const { status } = normalizeGoogleError(error);
  return status === undefined || status === 401 || isRetryableGoogleError(error);
}

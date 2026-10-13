import { Readable } from 'node:stream';
import { resumableUpload, ResumableUploadParams, UploadHttp } from './resumable-upload';

const CONTENT = Buffer.from('0123456789abcdefghij'); // 20 bytes

type Request = Parameters<UploadHttp['request']>[0];

/** Fallo de red tal como lo entrega gaxios: sin status, con código. */
const networkError = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {}, headers: {} } });

const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

/**
 * Google en memoria: guarda los bytes de la sesión y, en cada PUT con datos,
 * aplica el siguiente guion de `plan` (`{ cutAfter }` corta la conexión tras
 * recibir esos bytes; `{ fail }` responde con ese error sin leer nada).
 */
function fakeGoogle(plan: Array<{ cutAfter?: number; fail?: () => Error }> = []) {
  let received = Buffer.alloc(0);
  const puts: string[] = [];
  const queries: number[] = [];

  const http: UploadHttp = {
    request: jest.fn(async (req: Request) => {
      if (req.method === 'POST') {
        return { status: 200, data: undefined as never, headers: headers({ location: 'sesion-1' }) };
      }

      const range = req.headers?.['Content-Range'] ?? '';
      if (range.startsWith('bytes */')) {
        queries.push(received.length);
        if (received.length === CONTENT.length) {
          return { status: 200, data: { id: 'nuevo' } as never, headers: headers({}) };
        }
        const confirmed: Record<string, string> = received.length
          ? { range: `bytes=0-${received.length - 1}` }
          : {};
        return { status: 308, data: undefined as never, headers: headers(confirmed) };
      }

      puts.push(range);
      const step = plan.shift() ?? {};
      if (step.fail) throw step.fail();

      for await (const chunk of req.data as Readable) {
        const room = step.cutAfter === undefined ? chunk.length : step.cutAfter;
        received = Buffer.concat([received, (chunk as Buffer).subarray(0, room)]);
        if (step.cutAfter !== undefined) {
          step.cutAfter -= Math.min(room, chunk.length);
          if (step.cutAfter === 0) throw networkError();
        }
      }
      return { status: 200, data: { id: 'nuevo', size: String(received.length) } as never, headers: headers({}) };
    }) as UploadHttp['request'],
  };

  return { http, puts, queries, received: () => received };
}

/** Origen que entrega el contenido desde cualquier offset, en trozos de 4 bytes. */
const source = () =>
  jest.fn(async (offset: number) => {
    const rest = CONTENT.subarray(offset);
    const chunks: Buffer[] = [];
    for (let i = 0; i < rest.length; i += 4) chunks.push(rest.subarray(i, i + 4));
    return Readable.from(chunks);
  });

function params(
  google: ReturnType<typeof fakeGoogle>,
  extra: Partial<ResumableUploadParams> = {},
): ResumableUploadParams {
  return {
    name: 'video.mp4',
    mimeType: 'video/mp4',
    parentId: 'root',
    size: CONTENT.length,
    fields: 'id,size',
    authorize: jest.fn(async () => google.http),
    openSource: source(),
    maxResumes: 2,
    baseDelayMs: 1,
    sleep: async () => undefined,
    ...extra,
  };
}

describe('resumableUpload', () => {
  it('sin cortes, sube todo en un único PUT', async () => {
    const google = fakeGoogle();

    const file = await resumableUpload(params(google));

    expect(file.id).toBe('nuevo');
    expect(google.puts).toEqual(['bytes 0-19/20']);
    expect(google.received()).toEqual(CONTENT);
  });

  it('tras un corte, reanuda desde el último byte confirmado sin reenviar lo ya subido', async () => {
    const google = fakeGoogle([{ cutAfter: 8 }]);
    const p = params(google);

    const file = await resumableUpload(p);

    expect(file.id).toBe('nuevo');
    expect(p.openSource).toHaveBeenNthCalledWith(1, 0);
    expect(p.openSource).toHaveBeenNthCalledWith(2, 8);
    expect(google.puts).toEqual(['bytes 0-19/20', 'bytes 8-19/20']);
    // El archivo final es idéntico al original: ni huecos ni bytes repetidos.
    expect(google.received()).toEqual(CONTENT);
  });

  it('si el corte llega con todo ya recibido, no vuelve a enviar nada', async () => {
    const google = fakeGoogle([{ cutAfter: 20 }]);
    const p = params(google);

    const file = await resumableUpload(p);

    expect(file.id).toBe('nuevo');
    expect(google.puts).toHaveLength(1);
    expect(p.openSource).toHaveBeenCalledTimes(1);
  });

  it('cortes con avance no agotan los intentos; solo los que no avanzan', async () => {
    // maxResumes=2, pero 4 cortes que avanzan: debe llegar igualmente.
    const google = fakeGoogle([{ cutAfter: 4 }, { cutAfter: 4 }, { cutAfter: 4 }, { cutAfter: 4 }]);

    await expect(resumableUpload(params(google))).resolves.toMatchObject({ id: 'nuevo' });
    expect(google.received()).toEqual(CONTENT);
  });

  it('se rinde tras maxResumes cortes seguidos sin avance', async () => {
    const google = fakeGoogle([{ fail: networkError }, { fail: networkError }, { fail: networkError }]);

    await expect(resumableUpload(params(google))).rejects.toThrow(/socket hang up/);
    expect(google.puts).toHaveLength(3); // el intento inicial + 2 reanudaciones
  });

  it('no reanuda un error definitivo de Google (p. ej. cuota llena)', async () => {
    const google = fakeGoogle([{ fail: () => httpError(403) }]);

    await expect(resumableUpload(params(google))).rejects.toThrow(/HTTP 403/);
    expect(google.queries).toEqual([]);
  });

  it('ante un 401, reanuda pidiendo un token nuevo', async () => {
    const google = fakeGoogle([{ fail: () => httpError(401) }]);
    const p = params(google);

    await resumableUpload(p);

    expect(p.authorize).toHaveBeenLastCalledWith({ stale: true });
  });

  it('un fallo al abrir el origen no cuenta como corte: se propaga sin reintentar aquí', async () => {
    const google = fakeGoogle();
    const openSource = jest.fn().mockRejectedValue(new Error('origen no disponible'));

    await expect(resumableUpload(params(google, { openSource }))).rejects.toThrow(/origen no disponible/);
    expect(openSource).toHaveBeenCalledTimes(1);
    expect(google.puts).toEqual([]);
  });
});

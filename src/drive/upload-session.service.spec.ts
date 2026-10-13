import { HttpException } from '@nestjs/common';
import { GoogleAccount, UploadSession } from '@prisma/client';
import { Readable } from 'node:stream';
import { AppConfiguration } from '../config/configuration';
import { DriveClientFactory, DriveContext } from '../google/drive-client.factory';
import { PrismaService } from '../prisma/prisma.service';
import { UploadHttp } from './resumable-upload';
import { CHUNK_GRANULE, parseChunkRange, UploadSessionService } from './upload-session.service';

const SIZE = 2 * CHUNK_GRANULE + 10;
const CONTENT = Buffer.alloc(SIZE, 7);

type Request = Parameters<UploadHttp['request']>[0];
const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});
const networkError = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {}, headers: {} } });

/**
 * Google en memoria para una sola sesión: acumula lo que recibe, responde 308
 * con el rango confirmado mientras falte algo, y 200 con el archivo al final.
 * `cutAfter` corta la conexión tras recibir esos bytes del siguiente PUT.
 */
function fakeGoogle() {
  let received = 0;
  let gone = false;
  const plan: Array<{ cutAfter?: number; fail?: () => Error }> = [];

  const status = () =>
    received === SIZE
      ? { status: 200, data: { id: 'nuevo', name: 'video.mp4', mimeType: 'video/mp4' } as never, headers: headers({}) }
      : {
          status: 308,
          data: undefined as never,
          headers: headers(received ? { range: `bytes=0-${received - 1}` } : {}),
        };

  const http: UploadHttp = {
    request: jest.fn(async (req: Request) => {
      if (gone) throw httpError(404);
      if (req.method === 'POST') return { status: 200, data: undefined as never, headers: headers({ location: 'sesion-1' }) };
      if (req.method === 'DELETE') return { status: 499, data: undefined as never, headers: headers({}) };

      const range = req.headers?.['Content-Range'] ?? '';
      if (range.startsWith('bytes */')) return status();

      const step = plan.shift() ?? {};
      if (step.fail) throw step.fail();
      const start = Number(/bytes (\d+)-/.exec(range)![1]);
      // Google no acepta bytes que no empiecen donde termina lo confirmado.
      if (start !== received) throw httpError(400);
      for await (const chunk of req.data as Readable) {
        const take = step.cutAfter === undefined ? chunk.length : Math.min(step.cutAfter, chunk.length);
        received += take;
        if (step.cutAfter !== undefined) {
          step.cutAfter -= take;
          if (step.cutAfter === 0) throw networkError();
        }
      }
      return status();
    }) as UploadHttp['request'],
  };

  return {
    http,
    plan,
    received: () => received,
    expire: () => {
      gone = true;
    },
  };
}

function harness() {
  const google = fakeGoogle();
  const rows = new Map<string, UploadSession>();
  const prisma = {
    uploadSession: {
      create: jest.fn(async ({ data }) => {
        const row = { id: '11111111-1111-1111-1111-111111111111', createdAt: new Date(), ...data } as UploadSession;
        rows.set(row.id, row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }) => {
        const row = rows.get(where.id);
        return row && row.accountId === where.accountId && row.expiresAt > where.expiresAt.gt ? row : null;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        if (where.id) rows.delete(where.id);
        return { count: 1 };
      }),
    },
  } as unknown as PrismaService;
  const clients = { invalidateToken: jest.fn() } as unknown as DriveClientFactory;
  const config = {
    drive: { uploadMaxBytes: 10 * 1024 * 1024, maxRetries: 0, retryBaseDelayMs: 1 },
  } as AppConfiguration;
  const account = { id: 'acc-1', email: 'a@gmail.com', alias: null } as GoogleAccount;
  const ctx = { account, auth: google.http } as unknown as DriveContext;
  return { service: new UploadSessionService(prisma, clients, config), google, rows, ctx, clients };
}

/** Lo que haría el navegador: un PUT por bloque, con sus cabeceras. */
function put(service: UploadSessionService, ctx: DriveContext, id: string, start: number, end: number) {
  return service.putChunk(
    ctx,
    id,
    { contentRange: `bytes ${start}-${end}/${SIZE}`, contentLength: String(end - start + 1) },
    Readable.from([CONTENT.subarray(start, end + 1)]),
  );
}

describe('parseChunkRange', () => {
  it('acepta bloques múltiplos de 256 KiB y un último bloque de cualquier tamaño', () => {
    expect(parseChunkRange(`bytes 0-${CHUNK_GRANULE - 1}/${SIZE}`, String(CHUNK_GRANULE), SIZE)).toEqual({
      start: 0,
      end: CHUNK_GRANULE - 1,
      size: SIZE,
    });
    expect(parseChunkRange(`bytes ${2 * CHUNK_GRANULE}-${SIZE - 1}/${SIZE}`, '10', SIZE).start).toBe(2 * CHUNK_GRANULE);
  });

  it.each([
    ['sin cabecera', undefined, '10', /Content-Range/],
    ['total distinto del de la sesión', 'bytes 0-9/999', '10', /no coincide con el tamaño/],
    ['rango fuera del archivo', `bytes 0-${SIZE}/${SIZE}`, String(SIZE + 1), /fuera del archivo/],
    ['Content-Length distinto del rango', `bytes 0-${CHUNK_GRANULE - 1}/${SIZE}`, '5', /no coincide con el rango/],
    ['bloque intermedio no alineado', 'bytes 0-99/' + SIZE, '100', /múltiplo de 262144/],
  ])('rechaza %s', (_case, range, length, message) => {
    expect(() => parseChunkRange(range, length, SIZE)).toThrow(message);
  });

  it('exige Content-Length (411)', () => {
    const error = (() => {
      try {
        parseChunkRange(`bytes 0-9/${SIZE}`, undefined, SIZE);
      } catch (e) {
        return e as HttpException;
      }
    })();
    expect(error?.getStatus()).toBe(411);
  });
});

describe('UploadSessionService', () => {
  it('sube por bloques y devuelve el archivo al terminar, olvidando la sesión', async () => {
    const { service, ctx, google, rows } = harness();

    const session = await service.create(ctx, { name: 'video.mp4', size: SIZE, mimeType: 'video/mp4' });
    expect(session).toMatchObject({ offset: 0, size: SIZE });
    expect(session).not.toHaveProperty('sessionUrl');

    expect(await put(service, ctx, session.id, 0, 2 * CHUNK_GRANULE - 1)).toMatchObject({ offset: 2 * CHUNK_GRANULE });
    const done = await put(service, ctx, session.id, 2 * CHUNK_GRANULE, SIZE - 1);

    expect(done.file).toMatchObject({ id: 'nuevo', account: { id: 'acc-1' } });
    expect(google.received()).toBe(SIZE);
    expect(rows.size).toBe(0);
  });

  it('tras un corte a mitad de bloque, el estado dice desde dónde seguir y se completa', async () => {
    const { service, ctx, google } = harness();
    const session = await service.create(ctx, { name: 'video.mp4', size: SIZE });

    google.plan.push({ cutAfter: 1000 });
    await expect(put(service, ctx, session.id, 0, 2 * CHUNK_GRANULE - 1)).rejects.toMatchObject({
      response: { code: 'UPLOAD_INTERRUPTED' },
    });

    const { offset } = await service.status(ctx, session.id);
    expect(offset).toBe(1000);
    // El cliente reenvía desde lo confirmado: último bloque, de cualquier tamaño.
    const done = await put(service, ctx, session.id, offset, SIZE - 1);
    expect(done.file?.id).toBe('nuevo');
    expect(google.received()).toBe(SIZE);
  });

  it('un 401 de Google interrumpe el bloque y descarta el token cacheado', async () => {
    const { service, ctx, google, clients } = harness();
    const session = await service.create(ctx, { name: 'video.mp4', size: SIZE });

    google.plan.push({ fail: () => httpError(401) });
    await expect(put(service, ctx, session.id, 0, SIZE - 1)).rejects.toMatchObject({
      response: { code: 'UPLOAD_INTERRUPTED' },
    });
    expect(clients.invalidateToken).toHaveBeenCalledWith('acc-1');
  });

  it('un error definitivo (cuota llena) no se presenta como corte reanudable', async () => {
    const { service, ctx, google } = harness();
    const session = await service.create(ctx, { name: 'video.mp4', size: SIZE });

    google.plan.push({ fail: () => httpError(403) });
    await expect(put(service, ctx, session.id, 0, SIZE - 1)).rejects.toMatchObject({
      response: { code: 'GOOGLE_API_ERROR' },
    });
  });

  it('si Google ya no conoce la sesión, responde 410 y la olvida', async () => {
    const { service, ctx, google, rows } = harness();
    const session = await service.create(ctx, { name: 'video.mp4', size: SIZE });

    google.expire();
    await expect(service.status(ctx, session.id)).rejects.toMatchObject({
      status: 410,
      response: { code: 'UPLOAD_SESSION_EXPIRED' },
    });
    expect(rows.size).toBe(0);
  });

  it('no deja usar la subida desde otra cuenta', async () => {
    const { service, ctx } = harness();
    const session = await service.create(ctx, { name: 'video.mp4', size: SIZE });
    const other = { ...ctx, account: { ...ctx.account, id: 'acc-2' } } as DriveContext;

    await expect(service.status(other, session.id)).rejects.toMatchObject({
      response: { code: 'UPLOAD_SESSION_NOT_FOUND' },
    });
  });

  it('rechaza abrir una subida mayor que UPLOAD_MAX_BYTES sin llamar a Google', async () => {
    const { service, ctx, google } = harness();

    await expect(service.create(ctx, { name: 'enorme.iso', size: 11 * 1024 * 1024 })).rejects.toThrow(/UPLOAD_MAX_BYTES/);
    expect(google.http.request).not.toHaveBeenCalled();
  });

  it('cancelar avisa a Google y olvida la sesión', async () => {
    const { service, ctx, google, rows } = harness();
    const session = await service.create(ctx, { name: 'video.mp4', size: SIZE });

    await service.cancel(ctx, session.id);

    expect(google.http.request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'DELETE', url: 'sesion-1' }));
    expect(rows.size).toBe(0);
  });
});

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Readable } from 'node:stream';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { DriveService } from '../src/drive/drive.service';
import { UploadSessionController } from '../src/drive/upload-session.controller';
import { UploadSessionService } from '../src/drive/upload-session.service';

const ACCOUNT = '22222222-2222-2222-2222-222222222222';
const UPLOAD = '11111111-1111-1111-1111-111111111111';

/**
 * Los unitarios del servicio le pasan un stream ya construido. Esto comprueba
 * el tramo que no ven: que, a través de Express y Nest de verdad, el cuerpo
 * binario de un `PUT` llega al servicio entero y sin consumir (ningún body
 * parser se lo queda antes) y con sus cabeceras de rango.
 */
describe('PUT /drive/:accountId/uploads/:uploadId (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  const received: { body?: Buffer; headers?: Record<string, string | undefined> } = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadSessionController],
      providers: [
        { provide: DriveService, useValue: { context: jest.fn(async () => ({ account: { id: ACCOUNT } })) } },
        {
          provide: UploadSessionService,
          useValue: {
            putChunk: jest.fn(async (_ctx, _id, headers, body: Readable) => {
              const chunks: Buffer[] = [];
              for await (const chunk of body) chunks.push(chunk as Buffer);
              received.body = Buffer.concat(chunks);
              received.headers = headers;
              return { offset: received.body.length };
            }),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) => {
          ctx.switchToHttp().getRequest().user = { id: 'user-1' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('entrega al servicio los bytes exactos del bloque y su rango', async () => {
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251));

    const response = await fetch(`${base}/drive/${ACCOUNT}/uploads/${UPLOAD}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes 0-69999/70000` },
      body: bytes,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offset: 70_000 });
    expect(received.body?.equals(bytes)).toBe(true);
    expect(received.headers).toEqual({ contentRange: 'bytes 0-69999/70000', contentLength: '70000' });
  });

  it('rechaza un bloque que no sea application/octet-stream', async () => {
    const response = await fetch(`${base}/drive/${ACCOUNT}/uploads/${UPLOAD}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-range': 'bytes 0-1/2' },
      body: '{}',
    });

    expect(response.status).toBe(415);
  });
});

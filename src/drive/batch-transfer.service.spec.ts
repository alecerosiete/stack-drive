import { GoogleAccount } from '@prisma/client';
import { BatchTransferService } from './batch-transfer.service';
import { DriveService } from './drive.service';
import { DriveAggregateService } from './drive-aggregate.service';
import { DriveClientFactory, DriveContext } from '../google/drive-client.factory';
import { FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE, TreeNode } from './drive.types';
import { BatchTransferDto } from './dto/drive.dto';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

function account(id: string, email: string): GoogleAccount {
  return { id, userId: 'user-1', email, alias: null } as GoogleAccount;
}

const folder = (id: string, name: string): TreeNode => ({
  id,
  name,
  mimeType: FOLDER_MIME_TYPE,
  isFolder: true,
  size: null,
  md5Checksum: null,
  ownedByMe: true,
  createdTime: null,
  modifiedTime: null,
});
const file = (id: string, name: string, extra: Partial<TreeNode> = {}): TreeNode => ({
  id,
  name,
  mimeType: 'application/pdf',
  isFolder: false,
  size: 100,
  md5Checksum: `md5-${id}`,
  ownedByMe: true,
  createdTime: null,
  modifiedTime: null,
  ...extra,
});

/**
 * Doble de Drive con dos árboles en memoria (origen y destino). Basta para
 * comprobar la lógica del lote sin tocar la API real.
 */
function harness(sourceTree: Record<string, TreeNode[]>, targetTree: Record<string, TreeNode[]> = {}) {
  const nodes = new Map<string, TreeNode>();
  for (const children of Object.values(sourceTree)) children.forEach((n) => nodes.set(n.id, n));
  const sourceChildren = new Map(Object.entries(sourceTree));
  const targetChildren = new Map(Object.entries(targetTree));
  const deleted: Array<{ id: string; permanent: boolean }> = [];
  const created: Array<{ name: string; parentId: string }> = [];
  let seq = 0;

  const ctxFor = (id: string) =>
    ({ account: account(id, id === SOURCE ? 'origen@gmail.com' : 'destino@gmail.com') }) as unknown as DriveContext;
  const isSource = (ctx: DriveContext) => ctx.account.id === SOURCE;

  const drive = {
    getTreeNode: jest.fn(async (_ctx: DriveContext, id: string) => nodes.get(id)),
    listChildren: jest.fn(async (ctx: DriveContext, id: string) =>
      (isSource(ctx) ? sourceChildren : targetChildren)
        .get(id)
        ?.filter((n) => !deleted.some((d) => d.id === n.id)) ?? [],
    ),
    findFolderByName: jest.fn(async (ctx: DriveContext, parentId: string, name: string) => {
      const children = (isSource(ctx) ? sourceChildren : targetChildren).get(parentId) ?? [];
      return children.find((n) => n.isFolder && n.name === name) ?? null;
    }),
    createFolder: jest.fn(async (_ctx: DriveContext, dto: { name: string; parentId: string }) => {
      created.push(dto);
      const node = folder(`dest-${++seq}`, dto.name);
      targetChildren.set(dto.parentId, [...(targetChildren.get(dto.parentId) ?? []), node]);
      return { id: node.id };
    }),
    deleteFile: jest.fn(async (_ctx: DriveContext, id: string, permanent: boolean) => {
      deleted.push({ id, permanent });
    }),
    getQuota: jest.fn(async () => ({ freeBytes: 1000 })),
  } as unknown as DriveService;

  const transfer = jest.fn(async (_user: string, dto: { from: { fileId: string }; deleteSource?: boolean }) => {
    if (dto.deleteSource) deleted.push({ id: dto.from.fileId, permanent: false });
    return { uploaded: { id: `copia-${dto.from.fileId}` } };
  });
  const aggregate = { transfer } as unknown as DriveAggregateService;

  const clients = {
    forAccount: jest.fn(async (_user: string, id: string) => ctxFor(id)),
  } as unknown as DriveClientFactory;

  return { service: new BatchTransferService(clients, drive, aggregate), transfer, deleted, created, drive };
}

const batch = (ids: string[], extra: Partial<BatchTransferDto> = {}): BatchTransferDto => ({
  fromAccountId: SOURCE,
  toAccountId: TARGET,
  items: ids.map((id) => ({ id })),
  ...extra,
});

describe('BatchTransferService.run', () => {
  it('recrea la estructura, mueve cada archivo y borra la carpeta de origen vacía', async () => {
    const { service, transfer, deleted, created } = harness({
      root: [folder('F', 'Facturas')],
      F: [file('a', 'a.pdf'), folder('E', 'enero')],
      E: [file('b', 'b.pdf')],
    });

    const result = await service.run('user-1', batch(['F'], { deleteSource: true }));

    expect(created.map((c) => c.name)).toEqual(['Facturas', 'enero']);
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(result.items.map((i) => [i.path, i.status])).toEqual([
      ['Facturas/a.pdf', 'moved'],
      ['Facturas/enero/b.pdf', 'moved'],
    ]);
    // b.pdf va a la subcarpeta "enero" recreada, no a la raíz del destino.
    const sub = result.items.find((i) => i.name === 'b.pdf');
    expect(sub?.targetParentId).toBe('dest-2');
    expect(result.removedSourceFolders).toEqual(['Facturas']);
    expect(deleted.map((d) => d.id)).toContain('F');
  });

  it('copia los documentos de Google sin borrarlos y conserva la carpeta', async () => {
    const { service, transfer, deleted } = harness({
      root: [folder('F', 'Docs')],
      F: [file('d', 'Acta', { mimeType: 'application/vnd.google-apps.document', size: null, md5Checksum: null })],
    });

    const result = await service.run('user-1', batch(['F'], { deleteSource: true }));

    expect(transfer).toHaveBeenCalledWith('user-1', expect.objectContaining({ deleteSource: false }), expect.anything());
    expect(result.items[0]).toMatchObject({ status: 'copied' });
    expect(result.items[0].reason).toMatch(/se conserva/);
    expect(result.keptSourceFolders[0].name).toBe('Docs');
    expect(deleted).toEqual([]);
  });

  it('salta accesos directos y archivos ajenos al mover', async () => {
    const { service, transfer } = harness({
      root: [folder('F', 'Mixta')],
      F: [file('s', 'atajo', { mimeType: SHORTCUT_MIME_TYPE }), file('x', 'ajeno.pdf', { ownedByMe: false })],
    });

    const result = await service.run('user-1', batch(['F'], { deleteSource: true }));

    expect(transfer).not.toHaveBeenCalled();
    expect(result.counts.skipped).toBe(2);
  });

  it('un archivo que falla no detiene el lote y no se borra la carpeta', async () => {
    const { service, transfer, deleted } = harness({
      root: [folder('F', 'Fotos')],
      F: [file('ok', 'ok.jpg'), file('mal', 'mal.jpg')],
    });
    transfer.mockImplementation(async (_u, dto) => {
      if (dto.from.fileId === 'mal') throw new Error('Google Drive rechazó la operación');
      return { uploaded: { id: 'copia' } };
    });

    const result = await service.run('user-1', batch(['F'], { deleteSource: true }));

    expect(result.counts).toMatchObject({ moved: 1, failed: 1 });
    expect(result.items.find((i) => i.fileId === 'mal')?.targetParentId).toBe('dest-1');
    expect(result.keptSourceFolders).toEqual([{ name: 'Fotos', reason: '1 elemento sigue en el origen' }]);
    expect(deleted.map((d) => d.id)).not.toContain('F');
  });

  it('al combinar, reutiliza la carpeta existente y no vuelve a subir copias idénticas', async () => {
    const { service, transfer, created } = harness(
      { root: [folder('F', 'Facturas')], F: [file('a', 'a.pdf'), file('b', 'b.pdf')] },
      { root: [folder('existente', 'Facturas')], existente: [file('copia-previa', 'a.pdf', { md5Checksum: 'md5-a' })] },
    );

    const result = await service.run('user-1', batch(['F'], { onConflict: 'merge' }));

    expect(created).toEqual([]);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(result.items.map((i) => [i.name, i.status])).toEqual([
      ['a.pdf', 'already'],
      ['b.pdf', 'copied'],
    ]);
  });

  it('al combinar, reconoce la copia convertida de un documento de Google si es posterior a su última edición', async () => {
    const DOC = 'application/vnd.google-apps.document';
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const doc = (id: string, name: string, modifiedTime: string) =>
      file(id, name, { mimeType: DOC, size: null, md5Checksum: null, modifiedTime });
    const { service, transfer, deleted } = harness(
      {
        root: [folder('F', 'CV')],
        F: [doc('al-dia', 'CV 2021', '2025-09-26T12:00:00Z'), doc('editado', 'Carta', '2026-10-13T18:00:00Z')],
      },
      {
        root: [folder('existente', 'CV')],
        existente: [
          file('docx-1', 'CV 2021.docx', { mimeType: DOCX, md5Checksum: 'x', createdTime: '2026-10-13T16:04:00Z' }),
          file('docx-2', 'Carta.docx', { mimeType: DOCX, md5Checksum: 'y', createdTime: '2026-10-13T16:04:00Z' }),
        ],
      },
    );

    const result = await service.run('user-1', batch(['F'], { deleteSource: true, onConflict: 'merge' }));

    // Solo se vuelve a copiar el que se editó después de su copia.
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ from: expect.objectContaining({ fileId: 'editado' }) }),
      expect.anything(),
    );
    expect(Object.fromEntries(result.items.map((i) => [i.name, i.status]))).toEqual({
      'CV 2021': 'already',
      Carta: 'copied',
    });
    // Los documentos de Google nunca se borran, tampoco al reconocer su copia.
    expect(deleted).toEqual([]);
    expect(result.keptSourceFolders[0].name).toBe('CV');
  });

  it('con rename crea "Nombre (2)" en vez de combinar', async () => {
    const { service, created } = harness(
      { root: [folder('F', 'Facturas')], F: [file('a', 'a.pdf')] },
      { root: [folder('existente', 'Facturas')] },
    );

    await service.run('user-1', batch(['F'], { onConflict: 'rename' }));

    expect(created[0]).toEqual({ name: 'Facturas (2)', parentId: 'root' });
  });

  it('respeta la carpeta destino propia de cada elemento (reintentar fallidos)', async () => {
    const { service, transfer } = harness({ root: [file('a', 'a.pdf')] });

    await service.run('user-1', { ...batch([]), items: [{ id: 'a', parentId: 'sub-destino' }] });

    expect(transfer).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ to: { accountId: TARGET, parentId: 'sub-destino' } }),
      expect.anything(),
    );
  });

  it('rechaza origen y destino iguales', async () => {
    const { service } = harness({});
    await expect(service.run('user-1', { ...batch(['a']), toAccountId: SOURCE })).rejects.toThrow(/misma cuenta/);
  });
});

describe('BatchTransferService.preview', () => {
  it('cuenta archivos, bytes, documentos de Google y conflictos sin ejecutar nada', async () => {
    const { service, transfer } = harness(
      {
        root: [folder('F', 'Facturas'), file('suelto', 'suelto.zip', { size: 2000 })],
        F: [file('a', 'a.pdf'), file('d', 'Acta', { mimeType: 'application/vnd.google-apps.document', size: null })],
      },
      { root: [folder('existente', 'Facturas')] },
    );

    const preview = await service.preview('user-1', {
      fromAccountId: SOURCE,
      toAccountId: TARGET,
      ids: ['F', 'suelto'],
    });

    expect(preview).toMatchObject({
      files: 3,
      folders: 1,
      bytes: 2100,
      nativeDocs: 1,
      conflicts: [{ id: 'F', name: 'Facturas' }],
      targetFreeBytes: 1000,
      fits: false,
    });
    expect(transfer).not.toHaveBeenCalled();
  });
});

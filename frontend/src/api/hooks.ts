import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api } from '../lib/api';
import { assignAccountColors } from '../lib/account-color';
import { sessionStore } from '../lib/session';
import type {
  AggregateQuota,
  AggregateResult,
  DriveFile,
  DriveFilePage,
  GoogleAccount,
  LinkUrl,
  Profile,
  RebalancePlan,
  StorageQuota,
  TokenPair,
  TransferJob,
  TransferRequest,
} from './types';

/**
 * Claves de caché centralizadas: invalidar `['drive', accountId]` refresca
 * a la vez listados, cuota y metadatos de esa cuenta sin tocar las demás.
 */
export const keys = {
  me: ['me'] as const,
  accounts: ['accounts'] as const,
  quotaAll: ['quota'] as const,
  drive: (accountId: string) => ['drive', accountId] as const,
  folder: (accountId: string, folderId: string, opts: FolderOptions) =>
    ['drive', accountId, 'folder', folderId, opts] as const,
  file: (accountId: string, fileId: string) => ['drive', accountId, 'file', fileId] as const,
  accountQuota: (accountId: string) => ['drive', accountId, 'quota'] as const,
  search: (q: string) => ['search', q] as const,
  plan: (threshold: number | null) => ['rebalance', threshold] as const,
  transfers: ['transfers'] as const,
};

// ───────────────────────────── sesión ─────────────────────────────

export function useProfile(enabled = true) {
  return useQuery({ queryKey: keys.me, queryFn: () => api<Profile>('/auth/me'), enabled });
}

export function useLogin() {
  return useMutation({
    mutationFn: (input: { email: string; password: string; displayName?: string; mode: 'login' | 'register' }) =>
      api<TokenPair>(input.mode === 'login' ? '/auth/login' : '/auth/register', {
        method: 'POST',
        body:
          input.mode === 'login'
            ? { email: input.email, password: input.password }
            : { email: input.email, password: input.password, displayName: input.displayName || undefined },
      }),
    onSuccess: (tokens) => sessionStore.set({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
  });
}

export async function logout(queryClient: QueryClient, everywhere = false): Promise<void> {
  const session = sessionStore.get();
  try {
    if (everywhere) await api('/auth/logout-all', { method: 'POST' });
    else if (session) await api('/auth/logout', { method: 'POST', body: { refreshToken: session.refreshToken } });
  } catch {
    /* si el token ya había caducado, igualmente se limpia la sesión local */
  }
  sessionStore.set(null);
  queryClient.clear();
}

// ───────────────────────────── cuentas ─────────────────────────────

export function useAccounts() {
  return useQuery({
    queryKey: keys.accounts,
    queryFn: async () => {
      const accounts = await api<GoogleAccount[]>('/accounts');
      // Antes de que nadie pinte: los colores de capa dependen del conjunto.
      assignAccountColors(accounts);
      return accounts;
    },
  });
}

export function useLinkAccount() {
  return useMutation({
    mutationFn: (input: { alias?: string; loginHint?: string; redirectTo: string }) =>
      api<LinkUrl>('/google/link', { method: 'POST', body: input }),
  });
}

export function useReauthAccount() {
  return useMutation({
    mutationFn: (input: { accountId: string; redirectTo: string }) =>
      api<LinkUrl>(`/accounts/${input.accountId}/reauth`, {
        method: 'POST',
        query: { redirectTo: input.redirectTo },
      }),
  });
}

export function useRenameAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; alias: string }) =>
      api<GoogleAccount>(`/accounts/${input.accountId}`, { method: 'PATCH', body: { alias: input.alias } }),
    // Optimista: el alias cambia en toda la UI al instante.
    onMutate: async ({ accountId, alias }) => {
      await qc.cancelQueries({ queryKey: keys.accounts });
      const previous = qc.getQueryData<GoogleAccount[]>(keys.accounts);
      qc.setQueryData<GoogleAccount[]>(keys.accounts, (list) =>
        list?.map((a) => (a.id === accountId ? { ...a, alias } : a)),
      );
      return { previous };
    },
    onError: (_error, _input, context) => qc.setQueryData(keys.accounts, context?.previous),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useUnlinkAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api<void>(`/accounts/${accountId}`, { method: 'DELETE' }),
    onSuccess: (_data, accountId) => {
      qc.removeQueries({ queryKey: keys.drive(accountId) });
      void qc.invalidateQueries({ queryKey: keys.accounts });
      void qc.invalidateQueries({ queryKey: keys.quotaAll });
    },
  });
}

// ───────────────────────────── drive ─────────────────────────────

export interface FolderOptions {
  orderBy: 'folder,name' | 'name' | 'modifiedTime' | 'quotaBytesUsed';
  descending: boolean;
  includeTrashed: boolean;
}

export function useFolder(accountId: string, folderId: string, opts: FolderOptions) {
  return useQuery({
    queryKey: keys.folder(accountId, folderId, opts),
    queryFn: () =>
      api<DriveFilePage>(`/drive/${accountId}/files`, {
        query: { parentId: folderId, pageSize: 500, ...opts },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useFile(accountId: string, fileId: string | null) {
  return useQuery({
    queryKey: keys.file(accountId, fileId ?? ''),
    queryFn: () => api<DriveFile>(`/drive/${accountId}/files/${fileId}`),
    enabled: !!fileId && fileId !== 'root',
    staleTime: 5 * 60_000,
  });
}

export function useAccountQuota(accountId: string) {
  return useQuery({
    queryKey: keys.accountQuota(accountId),
    queryFn: () => api<StorageQuota>(`/drive/${accountId}/quota`),
    staleTime: 60_000,
  });
}

export function useAggregateQuota() {
  return useQuery({
    queryKey: keys.quotaAll,
    queryFn: () => api<AggregateQuota>('/drive/quota'),
    staleTime: 60_000,
  });
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: keys.search(q),
    queryFn: () => api<AggregateResult<DriveFilePage>>('/drive/search', { query: { q, limitPerAccount: 50 } }),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });
}

/** Tras cambiar algo en una cuenta, refresca esa cuenta y los agregados. */
function invalidateDrive(qc: QueryClient, accountId: string) {
  void qc.invalidateQueries({ queryKey: keys.drive(accountId) });
  void qc.invalidateQueries({ queryKey: keys.quotaAll });
  void qc.invalidateQueries({ queryKey: ['search'] });
}

export function useCreateFolder(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; parentId: string }) =>
      api<DriveFile>(`/drive/${accountId}/folders`, { method: 'POST', body: input }),
    onSuccess: () => invalidateDrive(qc, accountId),
  });
}

export function useUpdateFile(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileId: string; name?: string; parentId?: string; trashed?: boolean }) => {
      const { fileId, ...body } = input;
      return api<DriveFile>(`/drive/${accountId}/files/${fileId}`, { method: 'PATCH', body });
    },
    // Optimista sobre los listados cacheados de la cuenta: renombrar o mandar
    // a la papelera se refleja sin esperar el viaje de ida y vuelta a Google.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.drive(accountId) });
      const snapshots = qc.getQueriesData<DriveFilePage>({ queryKey: [...keys.drive(accountId), 'folder'] });
      for (const [key, page] of snapshots) {
        if (!page) continue;
        const files = page.files.flatMap((f) => {
          if (f.id !== input.fileId) return [f];
          const moved = input.parentId !== undefined && !f.parents.includes(input.parentId);
          const hidden = input.trashed === true && !(key[4] as FolderOptions | undefined)?.includeTrashed;
          if (moved || hidden) return [];
          return [{ ...f, name: input.name ?? f.name, trashed: input.trashed ?? f.trashed }];
        });
        qc.setQueryData(key, { ...page, files });
      }
      return { snapshots };
    },
    onError: (_e, _i, context) => context?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data)),
    onSettled: () => invalidateDrive(qc, accountId),
  });
}

export function useDeleteFile(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      api<void>(`/drive/${accountId}/files/${fileId}`, { method: 'DELETE', query: { permanent: true } }),
    onSuccess: () => invalidateDrive(qc, accountId),
  });
}

/**
 * Vacía la papelera de una cuenta. Google tarda un rato en recalcular la
 * cuota, así que refrescarla en el acto devolvería la cifra vieja: se descuenta
 * en caché lo liberado y solo se recargan los listados.
 */
export function useEmptyTrash(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ freedBytes: number }>(`/drive/${accountId}/trash`, { method: 'DELETE' }),
    onSuccess: ({ freedBytes }) => {
      const release = (q: StorageQuota): StorageQuota => {
        if (q.account.id !== accountId) return q;
        const usage = Math.max(q.usage - freedBytes, 0);
        return {
          ...q,
          usage,
          usageInDrive: Math.max(q.usageInDrive - freedBytes, 0),
          usageInDriveTrash: 0,
          freeBytes: q.limit === null ? null : Math.max(q.limit - usage, 0),
          usedPercent: q.limit ? Math.round((usage / q.limit) * 1000) / 10 : q.usedPercent,
        };
      };
      qc.setQueryData<StorageQuota>(keys.accountQuota(accountId), (q) => q && release(q));
      qc.setQueryData<AggregateQuota>(keys.quotaAll, (agg) => {
        if (!agg) return agg;
        const usage = Math.max(agg.totals.usage - freedBytes, 0);
        return {
          ...agg,
          results: agg.results.map(release),
          totals: { ...agg.totals, usage, freeBytes: agg.totals.limit === null ? null : Math.max(agg.totals.limit - usage, 0) },
        };
      });
      void qc.invalidateQueries({ queryKey: [...keys.drive(accountId), 'folder'] });
    },
  });
}

export function invalidateAfterUpload(qc: QueryClient, accountId: string) {
  invalidateDrive(qc, accountId);
}

// ─────────────────────── redistribución y transferencias ───────────────────────

export function useRebalancePlan(threshold: number | null) {
  return useQuery({
    queryKey: keys.plan(threshold),
    queryFn: () => api<RebalancePlan>('/drive/rebalance/plan', { query: { threshold } }),
    staleTime: 30_000,
  });
}

const ACTIVE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

export function useTransfers() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.transfers,
    queryFn: async () => {
      const jobs = await api<TransferJob[]>('/drive/transfers', { query: { limit: 50 } });
      // Una transferencia recién terminada cambia la cuota de dos cuentas.
      const previous = qc.getQueryData<TransferJob[]>(keys.transfers) ?? [];
      const justFinished = jobs.filter(
        (job) => job.state === 'completed' && previous.some((p) => p.jobId === job.jobId && p.state !== 'completed'),
      );
      for (const job of justFinished) {
        if (job.request) {
          invalidateDrive(qc, job.request.from.accountId);
          invalidateDrive(qc, job.request.to.accountId);
        }
      }
      return jobs;
    },
    // Sondeo adaptativo: rápido solo mientras haya algo en marcha.
    refetchInterval: (query) =>
      query.state.data?.some((job) => ACTIVE_STATES.has(job.state)) ? 1500 : 15_000,
  });
}

export function isActiveJob(job: TransferJob): boolean {
  return ACTIVE_STATES.has(job.state);
}

/**
 * La API solo conoce el nombre del archivo cuando el job termina. Recordamos
 * aquí el nombre de lo que encola este navegador para que una transferencia
 * en curso no se muestre como un id opaco.
 */
const JOB_NAMES_KEY = 'stackdrive.transferNames';

function readJobNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(JOB_NAMES_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function transferName(jobId: string): string | undefined {
  return readJobNames()[jobId];
}

function rememberTransferName(jobId: string, name: string): void {
  try {
    const entries = Object.entries({ ...readJobNames(), [jobId]: name }).slice(-100);
    localStorage.setItem(JOB_NAMES_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* sin almacenamiento solo perdemos el nombre amigable */
  }
}

export function useEnqueueTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fileName, ...input }: TransferRequest & { fileName?: string }) =>
      api<{ jobId: string }>('/drive/transfers', { method: 'POST', body: input }).then((job) => {
        if (fileName) rememberTransferName(job.jobId, fileName);
        return job;
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.transfers }),
  });
}

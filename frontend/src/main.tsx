import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster, toast } from 'sonner';
import { ApiError } from './lib/api';
import { router } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      // No tiene sentido reintentar errores de cliente (401, 404, 409...):
      // solo los de red o los 5xx/429, que pueden ser transitorios.
      retry: (failureCount, error) =>
        failureCount < 2 && (!(error instanceof ApiError) || error.status >= 500 || error.status === 429),
    },
  },
  // Errores de mutaciones sin manejo propio: se notifican siempre.
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.options.onError) return;
      toast.error(error.message);
    },
  }),
  queryCache: new QueryCache({
    onError: (error, query) => {
      // Solo avisamos de fallos en segundo plano; el primer fallo ya se pinta en la vista.
      if (query.state.data !== undefined) toast.error(`No se pudo actualizar: ${error.message}`);
    },
  }),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster
        position="bottom-left"
        toastOptions={{
          classNames: {
            toast: '!bg-raised !border-line !text-ink !shadow-[var(--shadow)] !rounded-xl !font-sans',
            description: '!text-muted',
          },
        }}
      />
    </QueryClientProvider>
  </StrictMode>,
);

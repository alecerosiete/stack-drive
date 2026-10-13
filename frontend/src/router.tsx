import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { useSession } from './lib/session';
import { AppShell } from './features/layout/AppShell';
import { LoginPage } from './features/auth/LoginPage';
import { RouteError } from './features/layout/RouteError';

function RequireSession() {
  const session = useSession();
  const location = useLocation();
  return session ? <Outlet /> : <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
}

// Cada pantalla se carga bajo demanda: el primer pintado solo descarga el
// shell y la pantalla en la que se aterriza.
const page = (load: () => Promise<{ Component: React.ComponentType }>) => ({ lazy: load });

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  {
    element: <RequireSession />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, ...page(() => import('./features/dashboard/DashboardPage').then((m) => ({ Component: m.DashboardPage }))) },
          { path: 'accounts', ...page(() => import('./features/accounts/AccountsPage').then((m) => ({ Component: m.AccountsPage }))) },
          { path: 'drive/:accountId/:folderId?', ...page(() => import('./features/explorer/ExplorerPage').then((m) => ({ Component: m.ExplorerPage }))) },
          { path: 'search', ...page(() => import('./features/search/SearchPage').then((m) => ({ Component: m.SearchPage }))) },
          { path: 'rebalance', ...page(() => import('./features/rebalance/RebalancePage').then((m) => ({ Component: m.RebalancePage }))) },
          { path: 'transfers', ...page(() => import('./features/transfers/TransfersPage').then((m) => ({ Component: m.TransfersPage }))) },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '../../components/ui/EmptyState';

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Error desconocido';
  return (
    <div className="grid min-h-full place-items-center">
      <EmptyState
        icon={<TriangleAlert className="size-6" />}
        title="Algo se rompió en esta pantalla"
        action={<Link className="text-sm font-medium text-accent underline-offset-4 hover:underline" to="/">Volver al inicio</Link>}
      >
        {message}
      </EmptyState>
    </div>
  );
}

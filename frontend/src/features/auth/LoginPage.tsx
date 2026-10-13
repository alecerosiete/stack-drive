import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { useLogin } from '../../api/hooks';
import { useSession } from '../../lib/session';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Logo } from '../layout/Logo';
import { ApiError } from '../../lib/api';

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const login = useLogin();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (session) return <Navigate to={from} replace />;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    login.mutate(
      {
        mode,
        email: String(data.get('email')).trim(),
        password: String(data.get('password')),
        displayName: String(data.get('displayName') ?? '').trim(),
      },
      { onSuccess: () => navigate(mode === 'register' ? '/accounts' : from, { replace: true }), onError: () => undefined },
    );
  };

  const error = login.error instanceof ApiError ? login.error.message : login.error?.message;

  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      {/* Lado editorial: explica el producto con la propia metáfora visual. */}
      <aside className="relative hidden overflow-hidden border-r border-line bg-surface lg:flex lg:flex-col lg:justify-between p-12">
        <Logo />
        <div className="relative">
          <div className="mb-10 flex flex-col gap-3" aria-hidden>
            {[
              ['#ff7a3d', '72%', 'trabajo@gmail.com', '10.8 / 15 GB'],
              ['#3fb8a6', '38%', 'personal@gmail.com', '5.7 / 15 GB'],
              ['#e8c547', '91%', 'fotos.2019@gmail.com', '13.6 / 15 GB'],
              ['#7c8cf8', '12%', 'archivo@gmail.com', '1.8 / 15 GB'],
            ].map(([color, width, email, usage], i) => (
              <div key={email} className="animate-rise" style={{ animationDelay: `${150 + i * 110}ms` }}>
                <div className="mb-1.5 flex justify-between font-mono text-[11px] text-faint">
                  <span>{email}</span>
                  <span>{usage}</span>
                </div>
                <div className="h-9 overflow-hidden rounded-lg" style={{ background: `repeating-linear-gradient(135deg, ${color}22 0 6px, ${color}10 6px 12px)` }}>
                  <div className="h-full rounded-lg" style={{ width, background: color }} />
                </div>
              </div>
            ))}
          </div>
          <h1 className="font-display text-5xl leading-[0.95] font-bold tracking-[-0.04em] text-balance xl:text-6xl">
            Todas tus cuentas de Drive.
            <br />
            <span className="text-accent">Una sola pila.</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] text-muted text-pretty">
            Vincula tantas cuentas de Google como quieras y gestiona sus 15 GB gratuitos como si fueran un único disco.
            StackDrive no guarda ni un byte de tus archivos.
          </p>
        </div>
        <p className="font-mono text-xs text-faint">Los archivos viven en Google · Los tokens, cifrados con AES-256-GCM</p>
      </aside>

      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm animate-rise">
          <Logo className="mb-10 lg:hidden" />
          <h2 className="font-display text-3xl font-bold tracking-[-0.03em]">
            {mode === 'login' ? 'Bienvenido de nuevo' : 'Crea tu cuenta'}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {mode === 'login' ? 'Entra para ver tu pila de almacenamiento.' : 'Después vincularás tus cuentas de Google.'}
          </p>

          <form className="mt-8 flex flex-col gap-4" onSubmit={onSubmit} noValidate={false}>
            {mode === 'register' && <Field label="Nombre (opcional)" name="displayName" autoComplete="name" maxLength={120} />}
            <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
            <Field
              label="Contraseña"
              name="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 10 : 1}
              required
              hint={mode === 'register' ? 'Mínimo 10 caracteres.' : undefined}
            />
            {error && (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" loading={login.isPending} className="mt-2 w-full justify-center">
              {mode === 'login' ? 'Entrar' : 'Crear cuenta'}
              <ArrowRight className="size-4" />
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">
            {mode === 'login' ? '¿Aún no tienes cuenta?' : '¿Ya tienes cuenta?'}{' '}
            <button
              type="button"
              className="font-medium text-accent underline-offset-4 hover:underline"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                login.reset();
              }}
            >
              {mode === 'login' ? 'Regístrate' : 'Inicia sesión'}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}

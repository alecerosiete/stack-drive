/**
 * Carga y valida la configuración de entorno una sola vez, al arrancar.
 *
 * Preferimos fallar en el arranque antes que descubrir a mitad de una petición
 * que falta `GOOGLE_CLIENT_SECRET` o que la clave de cifrado no es de 32 bytes.
 */

export interface EncryptionKeyRing {
  /** Versión activa: la que se usa para cifrar material nuevo. */
  activeVersion: number;
  /** Todas las claves disponibles por versión, para poder descifrar lo antiguo. */
  keys: Record<number, Buffer>;
}

export interface AppConfiguration {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  corsOrigins: string[];
  auth: {
    jwtSecret: string;
    accessTokenTtl: string;
    refreshTokenTtlDays: number;
    bcryptRounds: number;
  };
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
    /** A dónde devolver el navegador tras completar el consentimiento. */
    postLinkRedirectUrl: string | null;
  };
  encryption: EncryptionKeyRing;
  drive: {
    maxRetries: number;
    retryBaseDelayMs: number;
    accessTokenSkewSeconds: number;
    uploadMaxBytes: number;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
    /** Prefijo de claves, para compartir una instancia entre entornos. */
    keyPrefix: string;
  };
  rebalance: {
    /** Fracción de cuota (0-1) a partir de la cual una cuenta está "bajo presión". */
    threshold: number;
    /** Nº máximo de movimientos que propone un plan. */
    maxMoves: number;
    /** Candidatos a examinar por cuenta al construir el plan. */
    candidateSampleSize: number;
  };
  quotaWatch: {
    /**
     * Vigilancia periódica de cuotas. Solo registra la presión de cada cuenta:
     * NUNCA mueve archivos por su cuenta (eso siempre lo dispara el usuario).
     */
    enabled: boolean;
    cron: string;
  };
  jobs: {
    /** Transferencias simultáneas por worker. Cada una ocupa ancho de banda. */
    transferConcurrency: number;
    /** Intentos totales de una transferencia antes de darla por fallida. */
    transferAttempts: number;
  };
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`Configuración inválida: ${message}`);
    this.name = 'ConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(`falta la variable de entorno ${key}`);
  }
  return value;
}

function optionalInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${key} debe ser numérico, recibido "${raw}"`);
  }
  return parsed;
}

function parseList(raw: string | undefined, fallback: string[] = []): string[] {
  if (!raw?.trim()) return fallback;
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Decodifica una clave AES-256 en base64 y comprueba que mida exactamente
 * 32 bytes: una clave corta degradaría silenciosamente la seguridad.
 */
function decodeKey(label: string, value: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(value, 'base64');
  } catch {
    throw new ConfigError(`${label} no es base64 válido`);
  }
  if (key.length !== 32) {
    throw new ConfigError(
      `${label} debe ser una clave AES-256 de 32 bytes en base64 (recibidos ${key.length} bytes). ` +
        `Genera una con: npm run keygen`,
    );
  }
  return key;
}

/**
 * Construye el anillo de claves. Admite dos formatos:
 *
 *   TOKEN_ENCRYPTION_KEY=<base64>                 → versión 1, sin rotación
 *   TOKEN_ENCRYPTION_KEYS=1:<base64>,2:<base64>   → múltiples versiones
 *   TOKEN_ENCRYPTION_KEY_VERSION=2                → cuál se usa para cifrar
 *
 * El formato con versiones permite rotar la clave maestra sin downtime: se
 * añade la nueva, se marca como activa y los sobres antiguos siguen siendo
 * descifrables hasta que se re-cifren.
 */
function buildKeyRing(env: NodeJS.ProcessEnv): EncryptionKeyRing {
  const multi = env.TOKEN_ENCRYPTION_KEYS?.trim();
  const keys: Record<number, Buffer> = {};

  if (multi) {
    for (const entry of parseList(multi)) {
      const separator = entry.indexOf(':');
      if (separator < 1) {
        throw new ConfigError(
          `TOKEN_ENCRYPTION_KEYS debe tener el formato "version:claveBase64", recibido "${entry}"`,
        );
      }
      const version = Number(entry.slice(0, separator));
      if (!Number.isInteger(version) || version < 1) {
        throw new ConfigError(`versión de clave inválida en TOKEN_ENCRYPTION_KEYS: "${entry}"`);
      }
      keys[version] = decodeKey(`TOKEN_ENCRYPTION_KEYS[${version}]`, entry.slice(separator + 1));
    }
  } else {
    keys[1] = decodeKey('TOKEN_ENCRYPTION_KEY', required(env, 'TOKEN_ENCRYPTION_KEY'));
  }

  const versions = Object.keys(keys).map(Number);
  const activeVersion = optionalInt(env, 'TOKEN_ENCRYPTION_KEY_VERSION', Math.max(...versions));
  if (!keys[activeVersion]) {
    throw new ConfigError(
      `TOKEN_ENCRYPTION_KEY_VERSION=${activeVersion} no existe en el anillo de claves (disponibles: ${versions.join(', ')})`,
    );
  }

  return { activeVersion, keys };
}

export const DEFAULT_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
];

export function loadConfiguration(env: NodeJS.ProcessEnv = process.env): AppConfiguration {
  const nodeEnv = (env.NODE_ENV?.trim() || 'development') as AppConfiguration['nodeEnv'];

  const jwtSecret = required(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new ConfigError('JWT_SECRET debe tener al menos 32 caracteres');
  }

  return {
    nodeEnv,
    port: optionalInt(env, 'PORT', 3000),
    corsOrigins: parseList(env.CORS_ORIGINS, ['http://localhost:5173']),
    auth: {
      jwtSecret,
      accessTokenTtl: env.JWT_ACCESS_TTL?.trim() || '15m',
      refreshTokenTtlDays: optionalInt(env, 'REFRESH_TOKEN_TTL_DAYS', 30),
      bcryptRounds: optionalInt(env, 'BCRYPT_ROUNDS', 12),
    },
    google: {
      clientId: required(env, 'GOOGLE_CLIENT_ID'),
      clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
      redirectUri: required(env, 'GOOGLE_REDIRECT_URI'),
      scopes: parseList(env.GOOGLE_SCOPES, DEFAULT_GOOGLE_SCOPES),
      postLinkRedirectUrl: env.POST_LINK_REDIRECT_URL?.trim() || null,
    },
    encryption: buildKeyRing(env),
    drive: {
      maxRetries: optionalInt(env, 'GOOGLE_MAX_RETRIES', 3),
      retryBaseDelayMs: optionalInt(env, 'GOOGLE_RETRY_BASE_DELAY_MS', 300),
      accessTokenSkewSeconds: optionalInt(env, 'ACCESS_TOKEN_SKEW_SECONDS', 60),
      uploadMaxBytes: optionalInt(env, 'UPLOAD_MAX_BYTES', 5 * 1024 * 1024 * 1024),
    },
    redis: {
      host: env.REDIS_HOST?.trim() || '127.0.0.1',
      port: optionalInt(env, 'REDIS_PORT', 6379),
      password: env.REDIS_PASSWORD?.trim() || undefined,
      db: optionalInt(env, 'REDIS_DB', 0),
      keyPrefix: env.REDIS_KEY_PREFIX?.trim() || 'stackdrive',
    },
    rebalance: {
      threshold: parseThreshold(env.REBALANCE_THRESHOLD),
      maxMoves: optionalInt(env, 'REBALANCE_MAX_MOVES', 25),
      candidateSampleSize: optionalInt(env, 'REBALANCE_CANDIDATE_SAMPLE', 200),
    },
    quotaWatch: {
      enabled: (env.QUOTA_WATCH_ENABLED?.trim() || 'false').toLowerCase() === 'true',
      cron: env.QUOTA_WATCH_CRON?.trim() || '0 */6 * * *',
    },
    jobs: {
      transferConcurrency: optionalInt(env, 'TRANSFER_CONCURRENCY', 2),
      transferAttempts: optionalInt(env, 'TRANSFER_ATTEMPTS', 3),
    },
  };
}

/**
 * El umbral es una fracción: 0.9 = 90 % de la cuota. Se valida el rango
 * porque un valor fuera de (0, 1) produciría planes absurdos (mover todo o
 * no mover nunca) sin ningún error visible.
 */
function parseThreshold(raw: string | undefined): number {
  if (!raw?.trim()) return 0.9;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ConfigError(
      `REBALANCE_THRESHOLD debe ser una fracción entre 0 y 1 (ej. 0.9), recibido "${raw}"`,
    );
  }
  return value;
}

/** Token de inyección para `AppConfiguration`. */
export const APP_CONFIG = 'APP_CONFIG';

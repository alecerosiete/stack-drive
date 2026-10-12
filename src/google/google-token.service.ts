import { Inject, Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { GoogleAccount } from '@prisma/client';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { TokenCryptoService } from '../crypto/token-crypto.service';
import { GoogleAccountRepository } from './google-account.repository';
import { GoogleAccountNeedsReauthException } from '../common/errors';
import { isInvalidGrant, normalizeGoogleError } from '../common/google-error.util';
import { withRetry } from '../common/retry';

interface CachedToken {
  accessToken: string;
  /** Epoch ms en el que el token deja de ser usable (ya con el margen aplicado). */
  usableUntil: number;
}

/**
 * Motor de ciclo de vida de credenciales (Token Refresh Engine).
 *
 * Es el único punto del sistema que descifra `refresh_token` y habla con el
 * endpoint de token de Google. El resto de la aplicación pide clientes ya
 * autorizados y nunca ve material sensible.
 *
 * Tres responsabilidades:
 *
 *  1. Caché en memoria del `access_token` por cuenta, con margen de seguridad,
 *     para no pedir uno nuevo en cada petición HTTP del usuario.
 *  2. Deduplicación de refrescos concurrentes: si llegan diez peticiones de la
 *     misma cuenta con el token caducado, se hace UNA sola llamada a Google.
 *  3. Degradación explícita: si el `refresh_token` ya no sirve, la cuenta pasa
 *     a NEEDS_REAUTH y se devuelve un error accionable, sin afectar a las
 *     demás cuentas del mismo usuario.
 *
 * La caché es por proceso. Con varias instancias cada una mantiene la suya, lo
 * cual es correcto (los access_token de Google son reutilizables en paralelo);
 * el coste es algún refresco extra tras un despliegue. Si eso llegara a
 * importar, este es el punto donde se sustituiría por Redis.
 */
@Injectable()
export class GoogleTokenService {
  private readonly logger = new Logger(GoogleTokenService.name);
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
    private readonly crypto: TokenCryptoService,
    private readonly accounts: GoogleAccountRepository,
  ) {}

  /**
   * Devuelve un cliente OAuth2 listo para firmar llamadas a la Drive API en
   * nombre de la cuenta indicada.
   */
  async getAuthorizedClient(account: GoogleAccount): Promise<OAuth2Client> {
    const accessToken = await this.getAccessToken(account);
    const client = this.createClient();
    client.setCredentials({ access_token: accessToken });
    return client;
  }

  async getAccessToken(account: GoogleAccount): Promise<string> {
    const cached = this.cache.get(account.id);
    if (cached && cached.usableUntil > Date.now()) {
      return cached.accessToken;
    }

    // Si ya hay un refresco en vuelo para esta cuenta, esperamos a ese.
    const pending = this.inFlight.get(account.id);
    if (pending) {
      return pending;
    }

    const refreshPromise = this.refreshAccessToken(account).finally(() => {
      this.inFlight.delete(account.id);
    });
    this.inFlight.set(account.id, refreshPromise);
    return refreshPromise;
  }

  /** Olvida el access_token cacheado (p. ej. tras un 401 inesperado). */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  private async refreshAccessToken(account: GoogleAccount): Promise<string> {
    if (account.status === 'UNLINKED' || !account.refreshTokenEnc) {
      throw new GoogleAccountNeedsReauthException(
        account.id,
        account.email,
        'La cuenta no tiene credenciales almacenadas',
      );
    }

    const refreshToken = this.crypto.open(
      { ciphertext: account.refreshTokenEnc, keyVersion: account.keyVersion },
      contextFor(account),
    );

    const client = this.createClient();
    client.setCredentials({ refresh_token: refreshToken });

    try {
      // getAccessToken() detecta que no hay access_token válido y canjea el
      // refresh_token contra https://oauth2.googleapis.com/token.
      const { token } = await withRetry(() => client.getAccessToken(), {
        retries: this.config.drive.maxRetries,
        baseDelayMs: this.config.drive.retryBaseDelayMs,
        operation: `refresh token (${account.email})`,
        logger: this.logger,
      });

      if (!token) {
        throw new Error('Google no devolvió access_token');
      }

      this.cacheToken(account.id, token, client.credentials.expiry_date ?? null);
      await this.persistSideEffects(account, client, refreshToken);

      if (account.status !== 'ACTIVE') {
        // Reconexión silenciosa: el token volvió a funcionar (p. ej. tras un
        // corte de red que se confundió con revocación).
        await this.accounts.update(account.id, { status: 'ACTIVE', statusError: null });
      }

      return token;
    } catch (error) {
      if (isInvalidGrant(error)) {
        const { message } = normalizeGoogleError(error);
        this.logger.warn(
          `refresh_token inválido para ${account.email} (${account.id}): ${message}. ` +
            'La cuenta queda marcada como NEEDS_REAUTH.',
        );
        this.cache.delete(account.id);
        await this.accounts.markNeedsReauth(account.id, message);
        throw new GoogleAccountNeedsReauthException(account.id, account.email, message);
      }

      const { message, status } = normalizeGoogleError(error);
      this.logger.error(
        `Fallo al renovar el token de ${account.email} (status=${status ?? 'n/a'}): ${message}`,
      );
      throw error;
    }
  }

  /**
   * Google normalmente mantiene el mismo `refresh_token`, pero puede rotarlo.
   * Si lo hace, hay que re-cifrar y guardar el nuevo o la cuenta se romperá en
   * el siguiente refresco. Aprovechamos el mismo punto para re-envolver
   * tokens cifrados con una clave maestra antigua.
   */
  private async persistSideEffects(
    account: GoogleAccount,
    client: OAuth2Client,
    previousRefreshToken: string,
  ): Promise<void> {
    const current = client.credentials.refresh_token;
    const rotated = Boolean(current && current !== previousRefreshToken);
    const rewrap = this.crypto.needsRewrap(account.keyVersion);

    if (!rotated && !rewrap) return;

    const sealed = this.crypto.seal(current ?? previousRefreshToken, contextFor(account));
    await this.accounts.update(account.id, {
      refreshTokenEnc: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    });

    this.logger.log(
      rotated
        ? `Google rotó el refresh_token de ${account.email}; se guardó el nuevo cifrado`
        : `refresh_token de ${account.email} re-cifrado con la clave v${sealed.keyVersion}`,
    );
  }

  private cacheToken(accountId: string, accessToken: string, expiryDate: number | null): void {
    const skewMs = this.config.drive.accessTokenSkewSeconds * 1000;
    // Si Google no informa la caducidad asumimos el valor habitual (1 h).
    const expiresAt = expiryDate ?? Date.now() + 3600 * 1000;
    const usableUntil = expiresAt - skewMs;

    // Con un margen mayor que la vida del token, no cacheamos: es preferible
    // pedir uno nuevo que servir uno a punto de caducar a mitad de subida.
    if (usableUntil > Date.now()) {
      this.cache.set(accountId, { accessToken, usableUntil });
    }
  }

  private createClient(): OAuth2Client {
    return new OAuth2Client({
      clientId: this.config.google.clientId,
      clientSecret: this.config.google.clientSecret,
      redirectUri: this.config.google.redirectUri,
    });
  }
}

/**
 * Datos asociados que autentican el sobre cifrado. Atan el ciphertext al par
 * (tenant, cuenta de Google): moverlo a otra fila lo vuelve indescifrable.
 */
export function contextFor(account: Pick<GoogleAccount, 'userId' | 'googleUserId'>): string {
  return `${account.userId}:${account.googleUserId}`;
}

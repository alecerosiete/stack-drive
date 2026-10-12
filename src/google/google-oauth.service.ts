import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import { GoogleAccount } from '@prisma/client';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCryptoService } from '../crypto/token-crypto.service';
import { GoogleAccountRepository } from './google-account.repository';
import { contextFor, GoogleTokenService } from './google-token.service';
import { InsufficientScopeException, InvalidOAuthStateException } from '../common/errors';
import { normalizeGoogleError } from '../common/google-error.util';

/** Sin este scope no podemos listar ni organizar el Drive del usuario. */
export const REQUIRED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
/** Alternativa restringida a los archivos creados por la app. */
export const LIMITED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface LinkUrlResult {
  authUrl: string;
  state: string;
  expiresAt: Date;
}

export interface LinkResult {
  account: GoogleAccount;
  /** `true` si ya existía y se han refrescado sus credenciales. */
  relinked: boolean;
  redirectTo: string | null;
}

/**
 * Flujo de vinculación OAuth 2.0 multi-cuenta.
 *
 * El punto delicado es que un mismo usuario de StackDrive enlaza N cuentas de
 * Google, así que el `state` no puede ser solo anti-CSRF: es también el hilo
 * que une el `code` que devuelve Google con el tenant que inició el flujo,
 * porque el callback llega sin cabecera `Authorization` (lo abre el navegador
 * desde el dominio de Google).
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
    private readonly prisma: PrismaService,
    private readonly crypto: TokenCryptoService,
    private readonly accounts: GoogleAccountRepository,
    private readonly tokens: GoogleTokenService,
  ) {}

  /** Paso 1: genera la URL de consentimiento a la que el frontend redirige. */
  async createLinkUrl(
    userId: string,
    options: { alias?: string; redirectTo?: string; loginHint?: string } = {},
  ): Promise<LinkUrlResult> {
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    await this.prisma.oAuthLinkState.deleteMany({
      where: { userId, OR: [{ expiresAt: { lt: new Date() } }, { consumedAt: { not: null } }] },
    });

    await this.prisma.oAuthLinkState.create({
      data: {
        state,
        userId,
        alias: options.alias?.trim() || null,
        redirectTo: options.redirectTo?.trim() || null,
        expiresAt,
      },
    });

    const authUrl = this.createClient().generateAuthUrl({
      // `offline` es lo que hace que Google entregue refresh_token.
      access_type: 'offline',
      scope: this.config.google.scopes,
      state,
      // Ojo: generateAuthUrl serializa también las claves con valor
      // `undefined` (`login_hint=` vacío), así que el campo se añade aparte
      // solo cuando hay valor.
      ...(options.loginHint ? { login_hint: options.loginHint } : {}),
      // `consent` fuerza a Google a devolver refresh_token también cuando el
      // usuario ya había autorizado antes (si no, solo lo manda la 1ª vez y
      // una re-vinculación dejaría la cuenta sin credencial renovable).
      // `select_account` es imprescindible en multi-cuenta: sin él, Google
      // reutiliza la sesión activa y el usuario vincularía la misma cuenta.
      prompt: 'consent select_account',
      include_granted_scopes: true,
    });

    return { authUrl, state, expiresAt };
  }

  /**
   * Paso 2: canjea el `code` del callback, identifica la cuenta y guarda el
   * `refresh_token` cifrado.
   */
  async completeLink(code: string, state: string): Promise<LinkResult> {
    const linkState = await this.consumeState(state);
    const client = this.createClient();

    let tokens;
    try {
      ({ tokens } = await client.getToken(code));
    } catch (error) {
      const { message } = normalizeGoogleError(error);
      throw new BadRequestException(
        `Google rechazó el código de autorización: ${message}. ` +
          'Lo más común es que el code ya se haya usado o que GOOGLE_REDIRECT_URI no coincida.',
      );
    }

    if (!tokens.refresh_token) {
      // Puede pasar si se quita `prompt=consent` o si el usuario llega por un
      // flujo ajeno. Sin refresh_token no hay acceso en segundo plano, que es
      // justo el requisito del producto, así que abortamos.
      throw new BadRequestException(
        'Google no devolvió refresh_token. Revoca el acceso de StackDrive en ' +
          'https://myaccount.google.com/permissions y repite la vinculación.',
      );
    }

    const identity = await this.resolveIdentity(client, tokens.id_token ?? null);
    const grantedScopes = (tokens.scope ?? '').split(' ').filter(Boolean);
    this.assertScopes(grantedScopes, identity.email);

    const sealed = this.crypto.seal(
      tokens.refresh_token,
      contextFor({ userId: linkState.userId, googleUserId: identity.googleUserId }),
    );

    const existing = await this.prisma.googleAccount.findUnique({
      where: {
        userId_googleUserId: {
          userId: linkState.userId,
          googleUserId: identity.googleUserId,
        },
      },
      select: { id: true, status: true },
    });

    const account = await this.accounts.upsertLinked({
      userId: linkState.userId,
      googleUserId: identity.googleUserId,
      email: identity.email,
      picture: identity.picture,
      alias: linkState.alias ?? identity.email,
      refreshTokenEnc: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      scopes: grantedScopes,
    });

    // Si la cuenta se re-vincula, el access_token cacheado pertenece a la
    // credencial anterior: lo descartamos para que el próximo uso refresque.
    this.tokens.invalidate(account.id);

    this.logger.log(
      `${existing ? 'Re-vinculada' : 'Vinculada'} cuenta ${identity.email} ` +
        `(${account.id}) al usuario ${linkState.userId}`,
    );

    return {
      account,
      relinked: Boolean(existing),
      redirectTo: linkState.redirectTo,
    };
  }

  /**
   * Revoca el acceso en Google y borra la credencial. Revocar es importante:
   * si solo borrásemos la fila, StackDrive seguiría apareciendo en los
   * permisos de la cuenta del usuario.
   */
  async revokeAndUnlink(userId: string, accountId: string): Promise<void> {
    const account = await this.accounts.findOrFail(userId, accountId);

    if (account.refreshTokenEnc) {
      try {
        const refreshToken = this.crypto.open(
          { ciphertext: account.refreshTokenEnc, keyVersion: account.keyVersion },
          contextFor(account),
        );
        await this.createClient().revokeToken(refreshToken);
      } catch (error) {
        // Si el token ya estaba revocado o ilegible, seguimos: el objetivo
        // (que StackDrive deje de tener acceso) se cumple igual.
        this.logger.warn(
          `No se pudo revocar en Google el token de ${account.email}: ` +
            `${normalizeGoogleError(error).message}`,
        );
      }
    }

    this.tokens.invalidate(account.id);
    await this.accounts.markUnlinked(account.id);
    this.logger.log(`Cuenta ${account.email} (${account.id}) desvinculada`);
  }

  /**
   * Marca el `state` como usado de forma atómica. El `updateMany` con las
   * condiciones en el `where` evita la carrera de dos callbacks simultáneos
   * con el mismo `state` (replay).
   */
  private async consumeState(state: string) {
    if (!state) {
      throw new InvalidOAuthStateException('falta el parámetro state');
    }

    const { count } = await this.prisma.oAuthLinkState.updateMany({
      where: { state, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });

    if (count !== 1) {
      throw new InvalidOAuthStateException(
        'el state es desconocido, ya fue usado o ha caducado (10 min). Reinicia la vinculación.',
      );
    }

    const linkState = await this.prisma.oAuthLinkState.findUnique({ where: { state } });
    if (!linkState) {
      throw new InvalidOAuthStateException('el state desapareció durante el proceso');
    }
    return linkState;
  }

  /**
   * Identifica la cuenta a partir del `id_token` firmado. Usamos el `sub` y no
   * el email como identificador: el email de una cuenta de Google puede
   * cambiar, el `sub` no.
   */
  private async resolveIdentity(client: OAuth2Client, idToken: string | null) {
    if (idToken) {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: this.config.google.clientId,
      });
      const payload = ticket.getPayload();
      if (payload?.sub && payload.email) {
        return {
          googleUserId: payload.sub,
          email: payload.email,
          picture: payload.picture ?? null,
        };
      }
    }

    // Respaldo para cuando no se pidió el scope `openid`.
    const { data } = await client.request<{ sub?: string; id?: string; email?: string; picture?: string }>({
      url: 'https://www.googleapis.com/oauth2/v3/userinfo',
    });
    const googleUserId = data.sub ?? data.id;
    if (!googleUserId || !data.email) {
      throw new BadRequestException(
        'No se pudo identificar la cuenta de Google. Asegúrate de incluir los scopes openid y userinfo.email.',
      );
    }
    return { googleUserId, email: data.email, picture: data.picture ?? null };
  }

  private assertScopes(granted: string[], email: string): void {
    const requested = this.config.google.scopes;
    const needsFullDrive = requested.includes(REQUIRED_DRIVE_SCOPE);
    const hasDrive = granted.includes(REQUIRED_DRIVE_SCOPE);
    const hasLimited = granted.includes(LIMITED_DRIVE_SCOPE);

    if (needsFullDrive ? !hasDrive : !(hasDrive || hasLimited)) {
      this.logger.warn(`La cuenta ${email} no concedió el scope de Drive (concedidos: ${granted.join(', ')})`);
      throw new InsufficientScopeException(email, [
        needsFullDrive ? REQUIRED_DRIVE_SCOPE : LIMITED_DRIVE_SCOPE,
      ]);
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

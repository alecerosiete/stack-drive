import { HttpException, HttpStatus } from '@nestjs/common';

/** Códigos de error estables que el frontend puede usar para ramificar. */
export const ErrorCode = {
  ACCOUNT_NOT_FOUND: 'GOOGLE_ACCOUNT_NOT_FOUND',
  ACCOUNT_NEEDS_REAUTH: 'GOOGLE_ACCOUNT_NEEDS_REAUTH',
  ACCOUNT_ALREADY_LINKED: 'GOOGLE_ACCOUNT_ALREADY_LINKED',
  GOOGLE_API_ERROR: 'GOOGLE_API_ERROR',
  INSUFFICIENT_SCOPE: 'GOOGLE_INSUFFICIENT_SCOPE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  INVALID_OAUTH_STATE: 'INVALID_OAUTH_STATE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * La cuenta no existe, no pertenece al usuario autenticado o está
 * desvinculada. Deliberadamente no distinguimos entre esos casos para no
 * filtrar la existencia de cuentas de otros tenants.
 */
export class GoogleAccountNotFoundException extends HttpException {
  constructor(accountId: string) {
    super(
      {
        code: ErrorCode.ACCOUNT_NOT_FOUND,
        message: `La cuenta de Google ${accountId} no existe o no está disponible para este usuario`,
      },
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * El `refresh_token` ya no sirve (revocado desde la cuenta de Google, caducado
 * por inactividad o invalidado al cambiar la contraseña). El frontend debe
 * ofrecer al usuario repetir el consentimiento para esa cuenta concreta,
 * sin afectar al resto de sus cuentas vinculadas.
 */
export class GoogleAccountNeedsReauthException extends HttpException {
  constructor(accountId: string, email: string, detail?: string) {
    super(
      {
        code: ErrorCode.ACCOUNT_NEEDS_REAUTH,
        message: `La cuenta ${email} necesita volver a autorizarse en StackDrive`,
        accountId,
        detail,
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class GoogleAccountAlreadyLinkedException extends HttpException {
  constructor(email: string) {
    super(
      {
        code: ErrorCode.ACCOUNT_ALREADY_LINKED,
        message: `La cuenta ${email} ya está vinculada a este usuario`,
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class InsufficientScopeException extends HttpException {
  /** @param accountRef Email o id de la cuenta; al vincular aún no hay id. */
  constructor(accountRef: string, missing: string[]) {
    super(
      {
        code: ErrorCode.INSUFFICIENT_SCOPE,
        message:
          'La cuenta no concedió todos los permisos necesarios. Repite la vinculación aceptando el acceso a Drive.',
        account: accountRef,
        missingScopes: missing,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

/** Error propagado desde la Google Drive API tras agotar los reintentos. */
export class GoogleApiException extends HttpException {
  constructor(operation: string, upstreamStatus: number | undefined, detail: string) {
    // 401/403 upstream no deben devolverse tal cual: para el cliente de
    // StackDrive la petición estaba bien autenticada, el problema es aguas
    // arriba. Se traducen a 502 salvo que sean errores de permisos del fichero.
    const status =
      upstreamStatus === 404
        ? HttpStatus.NOT_FOUND
        : upstreamStatus === 403
          ? HttpStatus.FORBIDDEN
          : upstreamStatus === 429
            ? HttpStatus.TOO_MANY_REQUESTS
            : HttpStatus.BAD_GATEWAY;

    super(
      {
        code: ErrorCode.GOOGLE_API_ERROR,
        message: `Google Drive rechazó la operación "${operation}"`,
        upstreamStatus,
        detail,
      },
      status,
    );
  }
}

export class InvalidOAuthStateException extends HttpException {
  constructor(reason: string) {
    super(
      { code: ErrorCode.INVALID_OAUTH_STATE, message: `Flujo de vinculación inválido: ${reason}` },
      HttpStatus.BAD_REQUEST,
    );
  }
}

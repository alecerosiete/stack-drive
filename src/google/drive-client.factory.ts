import { Injectable } from '@nestjs/common';
import { drive_v3, google } from 'googleapis';
import { GoogleAccount } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import { GoogleAccountRepository } from './google-account.repository';
import { GoogleTokenService } from './google-token.service';

export interface DriveContext {
  account: GoogleAccount;
  drive: drive_v3.Drive;
  /**
   * El mismo cliente autorizado que usa `drive`, para las peticiones que la
   * librería no cubre (la subida *resumable*). Solo lleva access_token.
   */
  auth: OAuth2Client;
}

/**
 * Instancia clientes de la Google Drive API v3 ya autorizados.
 *
 * Es el único sitio donde se construye un cliente de Drive: así la capa de
 * servicios trabaja siempre con credenciales frescas sin saber nada del
 * almacenamiento ni del refresco de tokens.
 */
@Injectable()
export class DriveClientFactory {
  constructor(
    private readonly accounts: GoogleAccountRepository,
    private readonly tokens: GoogleTokenService,
  ) {}

  /** Resuelve la cuenta (verificando propiedad) y devuelve su cliente. */
  async forAccount(userId: string, accountId: string): Promise<DriveContext> {
    const account = await this.accounts.findOrFail(userId, accountId);
    return this.forResolvedAccount(account);
  }

  async forResolvedAccount(account: GoogleAccount): Promise<DriveContext> {
    const auth = await this.tokens.getAuthorizedClient(account);
    void this.accounts.touch(account.id);
    return { account, auth, drive: google.drive({ version: 'v3', auth }) };
  }

  /** Todas las cuentas utilizables del usuario, para operaciones agregadas. */
  listAccounts(userId: string): Promise<GoogleAccount[]> {
    return this.accounts.findMany(userId, ['ACTIVE']);
  }

  /** Descarta el access_token cacheado: se usa al recibir un 401 inesperado. */
  invalidateToken(accountId: string): void {
    this.tokens.invalidate(accountId);
  }
}

import { Injectable } from '@nestjs/common';
import { GoogleAccountRepository } from '../google/google-account.repository';
import { GoogleOAuthService } from '../google/google-oauth.service';
import { GoogleAccountView, toAccountView, UpdateAccountDto } from './dto/account.dto';

/**
 * Gestión del inventario de cuentas de Google de un tenant. No habla con la
 * Drive API: solo con los metadatos del enlace.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly repository: GoogleAccountRepository,
    private readonly oauth: GoogleOAuthService,
  ) {}

  async list(userId: string): Promise<GoogleAccountView[]> {
    const accounts = await this.repository.findMany(userId);
    return accounts.map(toAccountView);
  }

  async get(userId: string, accountId: string): Promise<GoogleAccountView> {
    return toAccountView(await this.repository.findOrFail(userId, accountId));
  }

  async update(userId: string, accountId: string, dto: UpdateAccountDto): Promise<GoogleAccountView> {
    const account = await this.repository.findOrFail(userId, accountId);
    if (dto.alias === undefined) {
      return toAccountView(account);
    }
    return toAccountView(await this.repository.update(account.id, { alias: dto.alias.trim() }));
  }

  async unlink(userId: string, accountId: string): Promise<void> {
    await this.oauth.revokeAndUnlink(userId, accountId);
  }

  /**
   * URL de consentimiento para reparar una cuenta en NEEDS_REAUTH. Prerrellena
   * el selector con su email para que el usuario no autorice por error otra
   * cuenta distinta y acabe con un enlace duplicado.
   */
  async reauthUrl(userId: string, accountId: string, redirectTo?: string) {
    const account = await this.repository.findOrFail(userId, accountId);
    return this.oauth.createLinkUrl(userId, {
      alias: account.alias ?? undefined,
      loginHint: account.email,
      redirectTo,
    });
  }
}

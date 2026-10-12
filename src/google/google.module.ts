import { Module } from '@nestjs/common';
import { GoogleAccountRepository } from './google-account.repository';
import { GoogleTokenService } from './google-token.service';
import { GoogleOAuthService } from './google-oauth.service';
import { DriveClientFactory } from './drive-client.factory';
import { GoogleOAuthController } from './google-oauth.controller';

/**
 * Módulo de credenciales de Google: vinculación, refresco y fabricación de
 * clientes autorizados. Los módulos de negocio (accounts, drive) dependen de
 * este y nunca de `googleapis` directamente para autenticarse.
 */
@Module({
  controllers: [GoogleOAuthController],
  providers: [GoogleAccountRepository, GoogleTokenService, GoogleOAuthService, DriveClientFactory],
  exports: [GoogleAccountRepository, GoogleTokenService, GoogleOAuthService, DriveClientFactory],
})
export class GoogleModule {}

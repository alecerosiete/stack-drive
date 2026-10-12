import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { Inject } from '@nestjs/common';
import { GoogleOAuthService } from './google-oauth.service';
import { CreateLinkDto } from './dto/link.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';

@Controller('google')
export class GoogleOAuthController {
  constructor(
    private readonly oauth: GoogleOAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  /**
   * Paso 1 de la vinculación. Devuelve JSON en lugar de un 302 porque esta
   * ruta exige `Authorization: Bearer`, y una redirección del navegador no
   * puede llevar esa cabecera: es el frontend quien navega a `authUrl`.
   */
  @Post('link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  createLink(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateLinkDto) {
    return this.oauth.createLinkUrl(user.id, dto);
  }

  /**
   * Paso 2: Google redirige aquí al navegador del usuario. Ruta pública (no
   * hay Bearer posible); la identidad del tenant la aporta el `state`.
   */
  @Get('callback')
  async callback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    if (error) {
      // El usuario canceló en la pantalla de consentimiento.
      this.finish(res, null, { status: 'error', reason: error });
      return;
    }

    if (!code || !state) {
      this.finish(res, null, { status: 'error', reason: 'missing_code_or_state' });
      return;
    }

    const result = await this.oauth.completeLink(code, state);
    this.finish(res, result.redirectTo, {
      status: 'linked',
      accountId: result.account.id,
      email: result.account.email,
      relinked: String(result.relinked),
    });
  }

  /**
   * Cierra el flujo devolviendo al navegador al panel. Si no hay URL de
   * retorno configurada respondemos JSON, útil al probar con curl.
   */
  private finish(res: Response, stateRedirect: string | null, params: Record<string, string>): void {
    const target = stateRedirect ?? this.config.google.postLinkRedirectUrl;

    if (!target) {
      const status = params.status === 'error' ? HttpStatus.BAD_REQUEST : HttpStatus.OK;
      res.status(status).json(params);
      return;
    }

    const url = new URL(target);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    res.redirect(HttpStatus.FOUND, url.toString());
  }
}

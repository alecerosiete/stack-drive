import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthenticatedUser, JwtPayload } from '../../auth/auth.types';

/**
 * Valida el `Authorization: Bearer <jwt>` y deja el tenant en `request.user`.
 *
 * Todo el aislamiento multi-tenant del sistema se apoya en este dato: los
 * servicios nunca aceptan un `userId` que venga del cuerpo o la query, solo
 * el que resuelve este guard.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Falta la cabecera Authorization: Bearer <token>');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token de acceso inválido o caducado');
    }

    const user: AuthenticatedUser = { id: payload.sub, email: payload.email };
    (request as Request & { user?: AuthenticatedUser }).user = user;
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : undefined;
  }
}

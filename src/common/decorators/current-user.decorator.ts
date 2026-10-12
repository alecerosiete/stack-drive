import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/auth.types';

/** Inyecta el tenant autenticado. Requiere `JwtAuthGuard` en la ruta. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (!request.user) {
      // Programación defensiva: significa que falta @UseGuards(JwtAuthGuard).
      throw new InternalServerErrorException('Ruta sin guard de autenticación');
    }
    return request.user;
  },
);

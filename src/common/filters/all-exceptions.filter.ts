import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Filtro de último recurso.
 *
 * Garantiza dos cosas: que el cliente recibe siempre un JSON con la misma
 * forma (`{ statusCode, code, message }`) y que ningún error inesperado se
 * filtra al exterior con detalles internos (trazas, SQL, nombres de tabla).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Si ya se empezó a escribir la respuesta (típico en descargas por
    // streaming), no se puede enviar un JSON de error encima.
    if (response.headersSent) {
      this.logger.error(
        `Error después de enviar cabeceras en ${request.method} ${request.url}: ` +
          describe(exception),
      );
      response.destroy();
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response
        .status(status)
        .json(
          typeof body === 'object' && body !== null
            ? { statusCode: status, ...body }
            : { statusCode: status, message: body },
        );
      return;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Los códigos de Prisma (P2002, P2025...) no deben salir al cliente,
      // pero sí al log para poder diagnosticar.
      this.logger.error(
        `Error de base de datos ${exception.code} en ${request.method} ${request.url}`,
      );
      const isNotFound = exception.code === 'P2025';
      response.status(isNotFound ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST).json({
        statusCode: isNotFound ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST,
        code: isNotFound ? 'NOT_FOUND' : 'DATABASE_CONSTRAINT',
        message: isNotFound
          ? 'El recurso solicitado no existe'
          : 'La operación viola una restricción de datos',
      });
      return;
    }

    this.logger.error(
      `Error no controlado en ${request.method} ${request.url}: ${describe(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Error interno del servidor',
    });
  }
}

function describe(exception: unknown): string {
  return exception instanceof Error ? exception.message : String(exception);
}

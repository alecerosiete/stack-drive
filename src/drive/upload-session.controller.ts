import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { DriveService } from './drive.service';
import { CreateUploadSessionDto } from './dto/drive.dto';
import { UploadSessionService } from './upload-session.service';

/**
 * Subidas reanudables desde el navegador, por bloques.
 *
 *   POST   /drive/:accountId/uploads             abre la sesión → { id, offset: 0, chunkSize }
 *   PUT    /drive/:accountId/uploads/:uploadId   un bloque (Content-Range) → { offset } o { file }
 *   GET    /drive/:accountId/uploads/:uploadId   tras un corte: desde dónde seguir
 *   DELETE /drive/:accountId/uploads/:uploadId   cancela
 *
 * Para archivos pequeños sigue siendo más simple `POST /drive/:accountId/files`.
 */
@Controller('drive/:accountId/uploads')
@UseGuards(JwtAuthGuard)
export class UploadSessionController {
  constructor(
    private readonly drive: DriveService,
    private readonly uploads: UploadSessionService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateUploadSessionDto,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    return this.uploads.create(ctx, dto);
  }

  @Get(':uploadId')
  async status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    return this.uploads.status(ctx, uploadId);
  }

  /**
   * El cuerpo se lee como stream directamente de la petición. Solo se admite
   * `application/octet-stream`: con otro tipo, un body parser global podría
   * haberlo consumido antes de llegar aquí.
   */
  @Put(':uploadId')
  @HttpCode(HttpStatus.OK)
  async chunk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Req() req: Request,
  ) {
    if (!req.is('application/octet-stream')) {
      throw new UnsupportedMediaTypeException('Los bloques se envían como application/octet-stream');
    }
    const ctx = await this.drive.context(user.id, accountId);
    return this.uploads.putChunk(
      ctx,
      uploadId,
      { contentRange: req.headers['content-range'], contentLength: req.headers['content-length'] },
      req,
    );
  }

  @Delete(':uploadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    await this.uploads.cancel(ctx, uploadId);
  }
}

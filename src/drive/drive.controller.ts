import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { DriveService } from './drive.service';
import {
  CreateFolderDto,
  CreateFolderPathDto,
  ListFilesQueryDto,
  UpdateFileDto,
  UploadQueryDto,
} from './dto/drive.dto';
import { withUploadStream } from './upload-stream.util';

/**
 * Operaciones sobre UNA cuenta de Google concreta.
 *
 * El `accountId` de la ruta es el que selecciona el usuario en el panel; el
 * backend resuelve a partir de él las credenciales correctas, de modo que la
 * misma operación apunta a la cuenta elegida sin que el cliente sepa nada de
 * tokens.
 */
@Controller('drive/:accountId')
@UseGuards(JwtAuthGuard)
export class DriveController {
  private readonly logger = new Logger(DriveController.name);

  constructor(
    private readonly drive: DriveService,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  /** Listado de una carpeta (por defecto la raíz de esa cuenta). */
  @Get('files')
  async listFiles(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query() query: ListFilesQueryDto,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    return this.drive.listFiles(ctx, query);
  }

  @Get('quota')
  async quota(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    return this.drive.getQuota(ctx);
  }

  @Get('files/:fileId')
  async getFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('fileId') fileId: string,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    return this.drive.getFile(ctx, fileId);
  }

  /** Enlaces de Google (visualización/descarga) más el proxy de StackDrive. */
  @Get('files/:fileId/link')
  async getLinks(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('fileId') fileId: string,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    return this.drive.getLinks(ctx, fileId);
  }

  /**
   * Descarga el archivo haciendo de proxy: los bytes van de Google al cliente
   * sin materializarse en el servidor.
   */
  @Get('files/:fileId/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.drive.context(user.id, accountId);
    const file = await this.drive.download(ctx, fileId);

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', contentDisposition(file.filename));
    if (file.size !== null) {
      res.setHeader('Content-Length', String(file.size));
    }

    return new Promise<void>((resolve, reject) => {
      file.stream.on('error', (error: Error) => {
        this.logger.error(`Error descargando ${fileId} de ${ctx.account.email}: ${error.message}`);
        if (res.headersSent) {
          // Ya se enviaron bytes al cliente: no se puede cambiar a una
          // respuesta de error, solo cortar la conexión para que el cliente
          // detecte que el archivo está incompleto.
          res.destroy(error);
        } else {
          res.status(HttpStatus.BAD_GATEWAY).json({
            code: 'GOOGLE_API_ERROR',
            message: `No se pudo descargar el archivo: ${error.message}`,
          });
        }
        reject(error);
      });

      res.on('close', resolve);
      file.stream.pipe(res);
    }).catch(() => undefined); // el error ya se registró y se comunicó
  }

  /**
   * Sube un archivo a esta cuenta por streaming.
   *
   * Acepta `multipart/form-data` (una parte de archivo) o un cuerpo binario
   * directo con la cabecera `X-File-Name`. Los metadatos de destino van en la
   * query porque la subida a Google empieza antes de haber leído el cuerpo
   * completo.
   */
  @Post('files')
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query() query: UploadQueryDto,
    @Req() req: Request,
  ) {
    const ctx = await this.drive.context(user.id, accountId);

    return withUploadStream(req, this.config.drive.uploadMaxBytes, (file, context) =>
      this.drive.uploadFile(ctx, file, {
        // Un `parentId` enviado como campo del formulario solo sirve si llegó
        // antes de la parte del archivo; la query siempre tiene prioridad.
        parentId: query.parentId ?? context.fields.parentId,
        name: query.name ?? context.fields.name,
      }),
    );
  }

  @Post('folders')
  @HttpCode(HttpStatus.CREATED)
  async createFolder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateFolderDto,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    return this.drive.createFolder(ctx, dto);
  }

  /** Crea una estructura de carpetas completa (`informes/2026/Q1`). */
  @Post('folders/path')
  @HttpCode(HttpStatus.CREATED)
  async createFolderPath(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateFolderPathDto,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    const segments = dto.path.split('/').filter((segment) => segment.trim().length > 0);
    const folders = await this.drive.ensureFolderPath(ctx, segments, dto.parentId ?? 'root');
    return { path: dto.path, folders, leafId: folders.at(-1)?.id ?? dto.parentId ?? 'root' };
  }

  /** Renombra y/o mueve dentro de esta misma cuenta. */
  @Patch('files/:fileId')
  async updateFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('fileId') fileId: string,
    @Body() dto: UpdateFileDto,
  ) {
    const ctx = await this.drive.context(user.id, accountId);
    return this.drive.updateFile(ctx, fileId, dto);
  }

  /** Papelera por defecto; `?permanent=true` borra sin posibilidad de deshacer. */
  @Delete('files/:fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('fileId') fileId: string,
    @Query('permanent') permanent?: string,
  ): Promise<void> {
    const ctx = await this.drive.context(user.id, accountId);
    await this.drive.deleteFile(ctx, fileId, permanent === 'true');
  }
}

/**
 * Cabecera `Content-Disposition` segura.
 *
 * Un nombre con comillas o saltos de línea permitiría inyectar cabeceras, y
 * los caracteres no ASCII necesitan la forma `filename*` (RFC 5987) para que
 * el navegador los interprete bien.
 */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

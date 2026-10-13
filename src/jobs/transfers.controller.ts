import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { BatchTransferDto, TransferDto, TransferPreviewDto } from '../drive/dto/drive.dto';
import { BatchTransferService } from '../drive/batch-transfer.service';
import { TransferJobsService } from './transfer-jobs.service';

/**
 * Transferencias de archivos entre dos cuentas de Google del mismo usuario.
 *
 * Son asíncronas por diseño: mover 2 GB implica descargar y volver a subir el
 * archivo completo, mucho más de lo que aguanta una petición HTTP. El endpoint
 * responde 202 con un `jobId` y el panel consulta el progreso.
 */
@Controller('drive/transfers')
@UseGuards(JwtAuthGuard)
export class TransfersController {
  constructor(
    private readonly transfers: TransferJobsService,
    private readonly batches: BatchTransferService,
  ) {}

  /** Transferencias recientes del usuario, con su estado. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    return this.transfers.list(user.id, Number.isFinite(parsed) && parsed > 0 ? parsed : 20);
  }

  /**
   * Qué supondría transferir estos elementos: archivos, bytes, documentos de
   * Google, conflictos de nombre y si cabe en el destino. No ejecuta nada.
   * Es POST solo porque la lista de ids no cabe bien en una query string.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@CurrentUser() user: AuthenticatedUser, @Body() dto: TransferPreviewDto) {
    return this.batches.preview(user.id, dto);
  }

  /** Encola un lote: varios archivos y/o carpetas completas → `202 {jobId}`. */
  @Post('batch')
  @HttpCode(HttpStatus.ACCEPTED)
  createBatch(@CurrentUser() user: AuthenticatedUser, @Body() dto: BatchTransferDto) {
    return this.transfers.enqueueBatch(user.id, dto);
  }

  @Get(':jobId')
  status(@CurrentUser() user: AuthenticatedUser, @Param('jobId') jobId: string) {
    return this.transfers.status(user.id, jobId);
  }

  /**
   * Encola una transferencia. Con `deleteSource: true` el original se envía a
   * la papelera, pero solo después de verificar la integridad de la copia.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: TransferDto) {
    return this.transfers.enqueue(user.id, dto);
  }
}

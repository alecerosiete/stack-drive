import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { DriveAggregateService } from './drive-aggregate.service';
import { RebalanceQueryDto, SearchQueryDto } from './dto/drive.dto';

/**
 * Vista unificada de todas las cuentas de Google del usuario.
 *
 * Estas rutas se declaran antes que `drive/:accountId` en el módulo para que
 * `/drive/quota` no se interprete como una cuenta llamada "quota".
 */
@Controller('drive')
@UseGuards(JwtAuthGuard)
export class DriveAggregateController {
  constructor(private readonly aggregate: DriveAggregateService) {}

  /** Raíz de cada cuenta en una sola respuesta. */
  @Get('files')
  listAll(@CurrentUser() user: AuthenticatedUser, @Query('pageSize') pageSize?: string) {
    const parsed = Number(pageSize);
    return this.aggregate.listAll(user.id, Number.isFinite(parsed) && parsed > 0 ? parsed : 50);
  }

  /** Búsqueda simultánea en todas las cuentas (o en las indicadas). */
  @Get('search')
  search(@CurrentUser() user: AuthenticatedUser, @Query() query: SearchQueryDto) {
    return this.aggregate.search(user.id, query);
  }

  /** Cuota por cuenta, totales del tenant y destino sugerido para subir. */
  @Get('quota')
  quota(@CurrentUser() user: AuthenticatedUser) {
    return this.aggregate.quota(user.id);
  }

  /**
   * Propuesta de redistribución para bajar del umbral de cuota.
   *
   * Solo analiza y propone: no mueve ningún archivo. Cada movimiento que el
   * usuario acepte se ejecuta con `POST /drive/transfers`.
   */
  @Get('rebalance/plan')
  rebalancePlan(@CurrentUser() user: AuthenticatedUser, @Query() query: RebalanceQueryDto) {
    return this.aggregate.rebalancePlan(user.id, query);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { UpdateAccountDto } from './dto/account.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';

@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.accounts.list(user.id);
  }

  @Get(':accountId')
  get(@CurrentUser() user: AuthenticatedUser, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.accounts.get(user.id, accountId);
  }

  @Patch(':accountId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: UpdateAccountDto,
  ) {
    return this.accounts.update(user.id, accountId, dto);
  }

  /** Desvincula y revoca el acceso en Google. */
  @Delete(':accountId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ): Promise<void> {
    await this.accounts.unlink(user.id, accountId);
  }

  @Post(':accountId/reauth')
  @HttpCode(HttpStatus.OK)
  reauth(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('redirectTo') redirectTo?: string,
  ) {
    return this.accounts.reauthUrl(user.id, accountId, redirectTo);
  }
}

import { Injectable } from '@nestjs/common';
import { GoogleAccount, GoogleAccountStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleAccountNotFoundException } from '../common/errors';

/**
 * Acceso a datos de las cuentas de Google vinculadas.
 *
 * Toda consulta lleva `userId` en el `where`, nunca solo el `accountId`: es la
 * barrera que impide que un tenant toque las cuentas de otro aunque adivine
 * un UUID.
 */
@Injectable()
export class GoogleAccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(userId: string, statuses: GoogleAccountStatus[] = ['ACTIVE', 'NEEDS_REAUTH']) {
    return this.prisma.googleAccount.findMany({
      where: { userId, status: { in: statuses } },
      orderBy: { linkedAt: 'asc' },
    });
  }

  find(userId: string, accountId: string): Promise<GoogleAccount | null> {
    return this.prisma.googleAccount.findFirst({ where: { id: accountId, userId } });
  }

  /** Igual que `find`, pero lanza 404 si la cuenta no es de este usuario. */
  async findOrFail(userId: string, accountId: string): Promise<GoogleAccount> {
    const account = await this.find(userId, accountId);
    if (!account || account.status === 'UNLINKED') {
      throw new GoogleAccountNotFoundException(accountId);
    }
    return account;
  }

  upsertLinked(params: {
    userId: string;
    googleUserId: string;
    email: string;
    picture: string | null;
    alias: string | null;
    refreshTokenEnc: string;
    keyVersion: number;
    scopes: string[];
  }): Promise<GoogleAccount> {
    const { userId, googleUserId, ...rest } = params;
    return this.prisma.googleAccount.upsert({
      where: { userId_googleUserId: { userId, googleUserId } },
      // Re-vincular una cuenta existente actualiza el token y limpia el estado
      // de error: es el camino que sigue el usuario tras un NEEDS_REAUTH.
      update: { ...rest, status: 'ACTIVE', statusError: null, linkedAt: new Date() },
      create: { userId, googleUserId, ...rest, status: 'ACTIVE' },
    });
  }

  update(accountId: string, data: Prisma.GoogleAccountUpdateInput): Promise<GoogleAccount> {
    return this.prisma.googleAccount.update({ where: { id: accountId }, data });
  }

  markNeedsReauth(accountId: string, reason: string): Promise<GoogleAccount> {
    return this.prisma.googleAccount.update({
      where: { id: accountId },
      data: { status: 'NEEDS_REAUTH', statusError: reason.slice(0, 500) },
    });
  }

  markUnlinked(accountId: string): Promise<GoogleAccount> {
    return this.prisma.googleAccount.update({
      where: { id: accountId },
      // El sobre cifrado se borra: desvincular debe destruir la credencial,
      // no solo ocultarla.
      data: { status: 'UNLINKED', refreshTokenEnc: null, statusError: null },
    });
  }

  touch(accountId: string): Promise<unknown> {
    return this.prisma.googleAccount
      .update({ where: { id: accountId }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined); // telemetría: nunca debe tumbar la petición
  }
}

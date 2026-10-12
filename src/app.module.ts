import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuthModule } from './auth/auth.module';
import { GoogleModule } from './google/google.module';
import { AccountsModule } from './accounts/accounts.module';
import { DriveModule } from './drive/drive.module';
import { JobsModule } from './jobs/jobs.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    AppConfigModule,
    ThrottlerModule.forRoot([
      // Límite genérico y amplio: evita abusos obvios sin estorbar a un panel
      // que lista carpetas. Los límites finos por tenant, si hacen falta,
      // irían en los endpoints de subida.
      { ttl: 60_000, limit: 300 },
    ]),
    PrismaModule,
    CryptoModule,
    AuthModule,
    GoogleModule,
    AccountsModule,
    DriveModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

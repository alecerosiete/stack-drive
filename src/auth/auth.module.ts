import { Module } from '@nestjs/common';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Module({
  imports: [
    // `global: true` deja JwtService disponible en todos los módulos, que es
    // lo que necesita JwtAuthGuard para usarse en accounts/ y drive/.
    JwtModule.registerAsync({
      global: true,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfiguration) => ({
        secret: config.auth.jwtSecret,
        signOptions: {
          // `jsonwebtoken` tipa expiresIn como literal ("15m", "1h"...); el
          // valor viene de entorno, así que la conversión es inevitable.
          expiresIn: config.auth.accessTokenTtl as JwtSignOptions['expiresIn'],
          issuer: 'stackdrive',
        },
        verifyOptions: { issuer: 'stackdrive' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService],
})
export class AuthModule {}

// Primero de todo: carga `.env` en process.env. Tiene que ejecutarse antes de
// cualquier otro import, porque algunos módulos leen variables de entorno al
// cargarse (por ejemplo, la concurrencia del worker de transferencias).
import 'dotenv/config';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfiguration } from './config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get<AppConfiguration>(APP_CONFIG);
  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      // `whitelist` descarta cualquier propiedad que no esté declarada en el
      // DTO: el cliente no puede inyectar campos que el código no espera.
      whitelist: true,
      transform: true,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // Cierra conexiones de Prisma y Redis al recibir SIGTERM, para no dejar
  // transferencias a medias en un despliegue.
  app.enableShutdownHooks();

  await app.listen(config.port);
  logger.log(`StackDrive API escuchando en http://localhost:${config.port} [${config.nodeEnv}]`);
  logger.log(`Callback de Google configurado en ${config.google.redirectUri}`);
  logger.log(`Scopes solicitados: ${config.google.scopes.join(' ')}`);
}

void bootstrap();

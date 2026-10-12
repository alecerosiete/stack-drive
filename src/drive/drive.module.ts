import { Module } from '@nestjs/common';
import { GoogleModule } from '../google/google.module';
import { DriveService } from './drive.service';
import { DriveAggregateService } from './drive-aggregate.service';
import { DriveAggregateController } from './drive-aggregate.controller';
import { DriveController } from './drive.controller';

@Module({
  imports: [GoogleModule],
  // El orden importa: las rutas agregadas (/drive/files, /drive/quota) deben
  // registrarse antes que las paramétricas (/drive/:accountId/...).
  controllers: [DriveAggregateController, DriveController],
  providers: [DriveService, DriveAggregateService],
  exports: [DriveService, DriveAggregateService],
})
export class DriveModule {}

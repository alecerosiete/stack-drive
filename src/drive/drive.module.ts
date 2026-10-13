import { Module } from '@nestjs/common';
import { GoogleModule } from '../google/google.module';
import { DriveService } from './drive.service';
import { DriveAggregateService } from './drive-aggregate.service';
import { BatchTransferService } from './batch-transfer.service';
import { QuotaHistoryService } from './quota-history.service';
import { DriveAggregateController } from './drive-aggregate.controller';
import { DriveController } from './drive.controller';
import { UploadSessionController } from './upload-session.controller';
import { UploadSessionService } from './upload-session.service';

@Module({
  imports: [GoogleModule],
  // El orden importa: las rutas agregadas (/drive/files, /drive/quota) deben
  // registrarse antes que las paramétricas (/drive/:accountId/...).
  controllers: [DriveAggregateController, DriveController, UploadSessionController],
  providers: [
    DriveService,
    DriveAggregateService,
    BatchTransferService,
    QuotaHistoryService,
    UploadSessionService,
  ],
  exports: [DriveService, DriveAggregateService, BatchTransferService],
})
export class DriveModule {}

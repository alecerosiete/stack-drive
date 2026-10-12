import { Inject, Logger, Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { DriveModule } from '../drive/drive.module';
import { GoogleModule } from '../google/google.module';
import { QUOTA_WATCH_JOB, QUOTA_WATCH_QUEUE, TRANSFER_QUEUE } from './jobs.constants';
import { TransferJobsService } from './transfer-jobs.service';
import { TransferProcessor } from './transfer.processor';
import { QuotaWatchProcessor } from './quota-watch.processor';
import { TransfersController } from './transfers.controller';

/**
 * Trabajos en segundo plano sobre Redis (BullMQ).
 *
 * Depende de `DriveModule` en un solo sentido: los endpoints de transferencia
 * viven aquí, junto a la cola que los ejecuta, para no crear una dependencia
 * circular entre módulos.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfiguration) => ({
        // Se pasa la configuración en crudo (no una instancia de ioredis) para
        // que BullMQ cree las conexiones con las opciones que necesitan sus
        // workers (entre otras, maxRetriesPerRequest: null).
        connection: {
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
        },
        prefix: config.redis.keyPrefix,
      }),
    }),
    BullModule.registerQueue({ name: TRANSFER_QUEUE }, { name: QUOTA_WATCH_QUEUE }),
    DriveModule,
    GoogleModule,
  ],
  controllers: [TransfersController],
  providers: [TransferJobsService, TransferProcessor, QuotaWatchProcessor],
  exports: [TransferJobsService],
})
export class JobsModule implements OnModuleInit {
  private readonly logger = new Logger(JobsModule.name);

  constructor(
    @InjectQueue(QUOTA_WATCH_QUEUE) private readonly quotaWatch: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  /**
   * Registra (o retira) el job repetible de vigilancia de cuotas.
   *
   * `upsertJobScheduler` es idempotente, así que arrancar varias instancias de
   * la API no multiplica las ejecuciones: BullMQ mantiene un único
   * planificador por id.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.quotaWatch.enabled) {
      // Si la vigilancia se desactiva, hay que quitar el planificador que
      // pudiera haber quedado en Redis de un arranque anterior.
      const removed = await this.quotaWatch.removeJobScheduler(QUOTA_WATCH_JOB).catch(() => false);
      if (removed) {
        this.logger.log('Vigilancia de cuotas desactivada: planificador retirado');
      }
      return;
    }

    await this.quotaWatch.upsertJobScheduler(
      QUOTA_WATCH_JOB,
      { pattern: this.config.quotaWatch.cron },
      { name: QUOTA_WATCH_JOB },
    );
    this.logger.log(
      `Vigilancia de cuotas activa (cron "${this.config.quotaWatch.cron}"). ` +
        'Solo mide y registra: nunca mueve archivos.',
    );
  }
}

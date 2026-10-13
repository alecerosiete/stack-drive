import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { TRANSFER_QUEUE } from './jobs.constants';
import { TransferDto } from '../drive/dto/drive.dto';
import { TransferResult } from '../drive/drive-aggregate.types';

export interface TransferJobData {
  /** Se guarda en el job para poder comprobar la propiedad al consultarlo. */
  userId: string;
  transfer: TransferDto;
}

export interface TransferJobView {
  jobId: string;
  state: string;
  /** 0-100 mientras la transferencia está en curso. */
  progress: number;
  attemptsMade: number;
  createdAt: string | null;
  finishedAt: string | null;
  result: TransferResult | null;
  error: string | null;
  /**
   * Qué se pidió transferir. Sin esto el panel no sabe qué cuentas toca un
   * job hasta que termina (`result` solo existe al completarse).
   */
  request: TransferDto;
}

/**
 * Encola transferencias entre cuentas en lugar de ejecutarlas dentro de la
 * petición HTTP.
 *
 * Una transferencia es descarga + subida de todo el archivo: con 2 GB puede
 * durar minutos, más de lo que cualquier proxy o navegador mantiene abierta
 * una petición. En la cola sobrevive a un reinicio del proceso y se reintenta
 * sola si Google devuelve un error transitorio.
 */
@Injectable()
export class TransferJobsService {
  private readonly logger = new Logger(TransferJobsService.name);

  constructor(
    @InjectQueue(TRANSFER_QUEUE) private readonly queue: Queue<TransferJobData, TransferResult>,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  async enqueue(userId: string, transfer: TransferDto): Promise<{ jobId: string; state: string }> {
    const job = await this.queue.add(
      'transfer',
      { userId, transfer },
      {
        attempts: this.config.jobs.transferAttempts,
        backoff: { type: 'exponential', delay: 2000 },
        // Conservamos un rastro acotado para que el panel pueda consultar el
        // resultado sin que Redis crezca sin límite.
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3600, count: 500 },
      },
    );

    this.logger.log(
      `Transferencia encolada (job ${job.id}): ${transfer.from.fileId} ` +
        `de ${transfer.from.accountId} a ${transfer.to.accountId}`,
    );

    return { jobId: String(job.id), state: 'queued' };
  }

  /**
   * Estado de un job. Comprueba que pertenece al tenant que pregunta: los ids
   * de BullMQ son secuenciales y adivinables.
   */
  async status(userId: string, jobId: string): Promise<TransferJobView> {
    const job = await this.queue.getJob(jobId);
    if (!job || job.data?.userId !== userId) {
      throw new NotFoundException(`No existe la transferencia ${jobId}`);
    }

    const state = await job.getState();

    return {
      jobId: String(job.id),
      state,
      progress: typeof job.progress === 'number' ? job.progress : 0,
      attemptsMade: job.attemptsMade,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      result: (job.returnvalue as TransferResult | undefined) ?? null,
      error: job.failedReason ?? null,
      request: job.data.transfer,
    };
  }

  /** Transferencias recientes del tenant, más nuevas primero. */
  async list(userId: string, limit = 20): Promise<TransferJobView[]> {
    const jobs = await this.queue.getJobs(
      ['active', 'waiting', 'delayed', 'completed', 'failed'],
      0,
      200,
    );

    const mine = jobs.filter((job) => job.data?.userId === userId).slice(0, limit);
    return Promise.all(
      mine.map(async (job) => ({
        jobId: String(job.id),
        state: await job.getState(),
        progress: typeof job.progress === 'number' ? job.progress : 0,
        attemptsMade: job.attemptsMade,
        createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        result: (job.returnvalue as TransferResult | undefined) ?? null,
        error: job.failedReason ?? null,
        request: job.data.transfer,
      })),
    );
  }
}

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { TRANSFER_QUEUE } from './jobs.constants';
import { BatchTransferDto, TransferDto } from '../drive/dto/drive.dto';
import {
  BatchProgress,
  BatchTransferResult,
  TransferResult,
} from '../drive/drive-aggregate.types';

export interface TransferJobData {
  /** Se guarda en el job para poder comprobar la propiedad al consultarlo. */
  userId: string;
  transfer: TransferDto;
}

export interface BatchJobData {
  userId: string;
  batch: BatchTransferDto;
}

export type AnyTransferJobData = TransferJobData | BatchJobData;
type AnyTransferResult = TransferResult | BatchTransferResult;

/** Nombres de job en la cola: el procesador ramifica por ellos. */
export const FILE_JOB = 'transfer';
export const BATCH_JOB = 'batch';

export interface TransferJobView {
  jobId: string;
  /** `file`: un archivo. `batch`: varios elementos y/o carpetas completas. */
  kind: 'file' | 'batch';
  state: string;
  /** 0-100 mientras la transferencia está en curso. */
  progress: number;
  /** Desglose del progreso de un lote (archivos, bytes, fase). */
  detail: BatchProgress | null;
  attemptsMade: number;
  createdAt: string | null;
  finishedAt: string | null;
  result: AnyTransferResult | null;
  error: string | null;
  /**
   * Qué se pidió transferir. Sin esto el panel no sabe qué cuentas toca un
   * job hasta que termina (`result` solo existe al completarse).
   */
  request: TransferDto | null;
  batch: BatchTransferDto | null;
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
    @InjectQueue(TRANSFER_QUEUE) private readonly queue: Queue<AnyTransferJobData, AnyTransferResult>,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  async enqueue(userId: string, transfer: TransferDto): Promise<{ jobId: string; state: string }> {
    const job = await this.queue.add(
      FILE_JOB,
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

    return this.toView(job);
  }

  /** Transferencias recientes del tenant, más nuevas primero. */
  async list(userId: string, limit = 20): Promise<TransferJobView[]> {
    const jobs = await this.queue.getJobs(
      ['active', 'waiting', 'delayed', 'completed', 'failed'],
      0,
      200,
    );

    const mine = jobs.filter((job) => job.data?.userId === userId).slice(0, limit);
    return Promise.all(mine.map((job) => this.toView(job)));
  }

  /**
   * Encola un lote (archivos y/o carpetas completas). Un solo intento a nivel
   * de job: reintentarlo entero volvería a subir lo que ya se copió. Los
   * fallos se anotan por archivo y el panel reintenta solo esos.
   */
  async enqueueBatch(userId: string, batch: BatchTransferDto): Promise<{ jobId: string; state: string }> {
    const job = await this.queue.add(
      BATCH_JOB,
      { userId, batch },
      {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3600, count: 500 },
      },
    );

    this.logger.log(
      `Lote encolado (job ${job.id}): ${batch.items.length} elemento(s) ` +
        `de ${batch.fromAccountId} a ${batch.toAccountId}`,
    );
    return { jobId: String(job.id), state: 'queued' };
  }

  private async toView(job: Job<AnyTransferJobData, AnyTransferResult>): Promise<TransferJobView> {
    const isBatch = 'batch' in job.data;
    const progress = job.progress;
    const detail =
      typeof progress === 'object' && progress !== null ? (progress as BatchProgress) : null;

    return {
      jobId: String(job.id),
      kind: isBatch ? 'batch' : 'file',
      state: await job.getState(),
      progress: typeof progress === 'number' ? progress : (detail?.percent ?? 0),
      detail,
      attemptsMade: job.attemptsMade,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      result: (job.returnvalue as AnyTransferResult | undefined) ?? null,
      error: job.failedReason ?? null,
      request: 'transfer' in job.data ? job.data.transfer : null,
      batch: 'batch' in job.data ? job.data.batch : null,
    };
  }
}

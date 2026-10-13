import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Convierte "true"/"1" de la query string en booleano real. */
const ToBoolean = () =>
  Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
    return undefined;
  });

export class ListFilesQueryDto {
  /** Carpeta padre. `root` es la raíz de "Mi unidad" de esa cuenta. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;

  /** Filtra por nombre (coincidencia parcial, no sensible a mayúsculas). */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mimeType?: string;

  /** Atajo para listar solo carpetas o solo archivos. */
  @IsOptional()
  @IsIn(['folders', 'files', 'all'])
  kind?: 'folders' | 'files' | 'all';

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  includeTrashed?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000) // tope impuesto por la Drive API
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  pageToken?: string;

  @IsOptional()
  @IsIn(['name', 'modifiedTime', 'createdTime', 'quotaBytesUsed', 'folder,name'])
  orderBy?: string;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  descending?: boolean;
}

export class CreateFolderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;
}

export class UpdateFileDto {
  /** Nuevo nombre. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  /** Nueva carpeta padre: mover dentro de la misma cuenta de Google. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  trashed?: boolean;
}

export class UploadQueryDto {
  /**
   * Los metadatos van en la query, no en campos del formulario: en una subida
   * por streaming el fichero puede llegar antes que los campos y necesitamos
   * saber el destino para abrir la petición contra Google.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}

export class SearchQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  q!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mimeType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limitPerAccount?: number;

  /** Restringe la búsqueda a un subconjunto de cuentas vinculadas. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsUUID('4', { each: true })
  accountIds?: string[];
}

export class TransferEndpointDto {
  @IsUUID()
  accountId!: string;

  @IsString()
  @MaxLength(256)
  fileId!: string;
}

export class TransferTargetDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}

export class TransferDto {
  @ValidateNested()
  @Type(() => TransferEndpointDto)
  from!: TransferEndpointDto;

  @ValidateNested()
  @Type(() => TransferTargetDto)
  to!: TransferTargetDto;

  /** Si `true`, borra el original tras copiarlo (mover entre cuentas). */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  deleteSource?: boolean;

  /**
   * Con `deleteSource`, borra el original de forma permanente en vez de
   * enviarlo a la papelera, para que la cuota de la cuenta origen se libere
   * en el acto. Solo tras verificar la copia, igual que la papelera.
   */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  permanentlyDeleteSource?: boolean;
}

export class CreateFolderPathDto {
  /** Ruta con barras: `informes/2026/Q1`. Crea solo los tramos que falten. */
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  path!: string;

  /** Carpeta desde la que se cuenta la ruta. Por defecto, la raíz. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;
}

export class RebalanceQueryDto {
  /** Fracción de cuota (0-1) que marca "bajo presión". Por defecto, la de entorno. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(0.99)
  threshold?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  maxMoves?: number;
}

export class QuotaHistoryQueryDto {
  /** Días hacia atrás. El vigilante purga lo que supere `QUOTA_HISTORY_DAYS`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

/** Un elemento de un lote: archivo o carpeta de la cuenta origen. */
export class BatchItemDto {
  @IsString()
  @MaxLength(256)
  id!: string;

  /**
   * Carpeta destino propia de este elemento. Solo la usa "reintentar
   * fallidos": cada archivo fallido vuelve a la subcarpeta que le tocaba.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;
}

export const CONFLICT_MODES = ['merge', 'rename'] as const;
export type ConflictMode = (typeof CONFLICT_MODES)[number];

/**
 * Transferencia de varios elementos (archivos y/o carpetas completas) de una
 * cuenta a otra en un solo trabajo.
 */
export class BatchTransferDto {
  @IsUUID()
  fromAccountId!: string;

  @IsUUID()
  toAccountId!: string;

  /** Carpeta destino. Por defecto, la raíz de la cuenta destino. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BatchItemDto)
  items!: BatchItemDto[];

  /** Mover: cada original se borra solo tras verificar su copia. */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  deleteSource?: boolean;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  permanentlyDeleteSource?: boolean;

  /**
   * Qué hacer si en el destino ya hay una carpeta con el mismo nombre:
   * `merge` la reutiliza (por defecto), `rename` crea "Nombre (2)".
   */
  @IsOptional()
  @IsIn(CONFLICT_MODES)
  onConflict?: ConflictMode;

  /** Nombre legible para el panel ("Facturas 2026", "5 elementos"). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

/** Qué implicaría transferir unos elementos, sin ejecutar nada. */
export class TransferPreviewDto {
  @IsUUID()
  fromAccountId!: string;

  @IsUUID()
  toAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  parentId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(256, { each: true })
  ids!: string[];
}

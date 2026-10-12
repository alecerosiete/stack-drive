import { Transform, Type } from 'class-transformer';
import {
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

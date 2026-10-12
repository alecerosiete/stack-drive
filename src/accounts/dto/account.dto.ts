import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { GoogleAccount, GoogleAccountStatus } from '@prisma/client';

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  alias?: string;
}

/**
 * Vista pública de una cuenta vinculada. Se construye por lista explícita de
 * campos para que ningún cambio futuro en el modelo pueda exponer por
 * descuido el sobre cifrado ni la versión de clave.
 */
export interface GoogleAccountView {
  id: string;
  email: string;
  alias: string | null;
  picture: string | null;
  status: GoogleAccountStatus;
  statusError: string | null;
  scopes: string[];
  linkedAt: Date;
  lastUsedAt: Date | null;
  /** `true` si el usuario debe repetir el consentimiento para esta cuenta. */
  needsReauth: boolean;
}

export function toAccountView(account: GoogleAccount): GoogleAccountView {
  return {
    id: account.id,
    email: account.email,
    alias: account.alias,
    picture: account.picture,
    status: account.status,
    statusError: account.statusError,
    scopes: account.scopes,
    linkedAt: account.linkedAt,
    lastUsedAt: account.lastUsedAt,
    needsReauth: account.status === 'NEEDS_REAUTH',
  };
}

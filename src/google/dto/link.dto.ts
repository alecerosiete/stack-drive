import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateLinkDto {
  /** Nombre con el que el usuario reconocerá la cuenta en su panel. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  alias?: string;

  /** URL del panel a la que volver tras el consentimiento. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  redirectTo?: string;

  /** Email sugerido en el selector de cuentas de Google. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  loginHint?: string;
}

import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { APP_CONFIG, AppConfiguration, EncryptionKeyRing } from '../config/configuration';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, tamaño recomendado para GCM
const AUTH_TAG_LENGTH = 16;

export interface SealedToken {
  /** base64(iv || authTag || ciphertext) */
  ciphertext: string;
  /** Versión de clave con la que se cifró, necesaria para descifrar después. */
  keyVersion: number;
}

export class TokenDecryptionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

/**
 * Cifrado simétrico autenticado de los `refresh_token` de Google.
 *
 * Usa AES-256-GCM, que además de confidencialidad aporta integridad: si
 * alguien altera un byte del sobre en la base de datos, el descifrado falla
 * en lugar de devolver basura.
 *
 * El contexto (`aad`) ata criptográficamente cada sobre a su fila: un sobre
 * copiado de la cuenta de un tenant a la de otro no se puede descifrar, de
 * modo que un acceso de escritura a la base de datos no basta para robar
 * credenciales ajenas.
 */
@Injectable()
export class TokenCryptoService {
  private readonly keyRing: EncryptionKeyRing;

  constructor(@Inject(APP_CONFIG) config: AppConfiguration) {
    this.keyRing = config.encryption;
  }

  /**
   * @param plaintext Secreto a proteger (el `refresh_token`).
   * @param context   Datos asociados no cifrados pero autenticados. Deben ser
   *                  reproducibles al descifrar; usamos el par
   *                  `userId:googleUserId` de la cuenta propietaria.
   */
  seal(plaintext: string, context: string): SealedToken {
    if (!plaintext) {
      throw new Error('No se puede cifrar un valor vacío');
    }

    const keyVersion = this.keyRing.activeVersion;
    const key = this.keyRing.keys[keyVersion];
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    cipher.setAAD(Buffer.from(context, 'utf8'));

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);

    return { ciphertext: envelope.toString('base64'), keyVersion };
  }

  open(sealed: SealedToken, context: string): string {
    const key = this.keyRing.keys[sealed.keyVersion];
    if (!key) {
      throw new TokenDecryptionError(
        `No hay clave de cifrado para la versión ${sealed.keyVersion}. ` +
          'Añádela a TOKEN_ENCRYPTION_KEYS para poder descifrar este token.',
      );
    }

    const envelope = Buffer.from(sealed.ciphertext, 'base64');
    if (envelope.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new TokenDecryptionError('El sobre cifrado está truncado o corrupto');
    }

    const iv = envelope.subarray(0, IV_LENGTH);
    const authTag = envelope.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = envelope.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      // Un fallo aquí significa clave incorrecta, contexto distinto o sobre
      // manipulado. En los tres casos el token es inservible.
      throw new TokenDecryptionError(
        'No se pudo descifrar el refresh_token: clave incorrecta o datos manipulados',
        error,
      );
    }
  }

  /** ¿El sobre está cifrado con una clave antigua y conviene re-cifrarlo? */
  needsRewrap(keyVersion: number): boolean {
    return keyVersion !== this.keyRing.activeVersion;
  }

  /** Hash determinista para tokens opacos que solo necesitamos comparar. */
  static hashOpaqueToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

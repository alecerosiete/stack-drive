import { randomBytes } from 'node:crypto';
import { TokenCryptoService, TokenDecryptionError } from './token-crypto.service';
import { AppConfiguration } from '../config/configuration';

const key = (): Buffer => randomBytes(32);

function serviceWith(keys: Record<number, Buffer>, activeVersion: number): TokenCryptoService {
  return new TokenCryptoService({
    encryption: { keys, activeVersion },
  } as AppConfiguration);
}

describe('TokenCryptoService', () => {
  const keyV1 = key();
  const keyV2 = key();
  const context = 'user-1:google-sub-1';
  const refreshToken = '1//0gX-fake-refresh-token-value';

  it('devuelve el mismo token al cifrar y descifrar con el contexto correcto', () => {
    const service = serviceWith({ 1: keyV1 }, 1);

    const sealed = service.seal(refreshToken, context);

    expect(sealed.ciphertext).not.toContain(refreshToken);
    expect(sealed.keyVersion).toBe(1);
    expect(service.open(sealed, context)).toBe(refreshToken);
  });

  it('produce un sobre distinto en cada cifrado del mismo token', () => {
    // El IV es aleatorio, así que dos sobres iguales delatarían un bug grave:
    // permitirían saber que dos cuentas comparten credencial.
    const service = serviceWith({ 1: keyV1 }, 1);

    const first = service.seal(refreshToken, context);
    const second = service.seal(refreshToken, context);

    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  it('no permite descifrar un sobre movido a otra cuenta', () => {
    // Es la garantía de aislamiento multi-tenant a nivel criptográfico: copiar
    // la fila de un usuario a otro no sirve para robar su credencial.
    const service = serviceWith({ 1: keyV1 }, 1);
    const sealed = service.seal(refreshToken, 'user-1:google-sub-1');

    expect(() => service.open(sealed, 'user-2:google-sub-1')).toThrow(TokenDecryptionError);
  });

  it('detecta la manipulación del ciphertext', () => {
    const service = serviceWith({ 1: keyV1 }, 1);
    const sealed = service.seal(refreshToken, context);

    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[bytes.length - 1] ^= 0xff; // un bit cambiado al final del mensaje

    expect(() =>
      service.open({ ...sealed, ciphertext: bytes.toString('base64') }, context),
    ).toThrow(TokenDecryptionError);
  });

  it('rechaza un sobre truncado', () => {
    const service = serviceWith({ 1: keyV1 }, 1);

    expect(() => service.open({ ciphertext: 'YWJj', keyVersion: 1 }, context)).toThrow(
      /truncado o corrupto/,
    );
  });

  it('descifra con una clave antigua y marca el sobre para re-cifrar', () => {
    // Escenario de rotación: lo cifrado con la v1 sigue siendo legible cuando
    // la clave activa ya es la v2.
    const oldService = serviceWith({ 1: keyV1 }, 1);
    const sealed = oldService.seal(refreshToken, context);

    const rotated = serviceWith({ 1: keyV1, 2: keyV2 }, 2);

    expect(rotated.open(sealed, context)).toBe(refreshToken);
    expect(rotated.needsRewrap(sealed.keyVersion)).toBe(true);
    expect(rotated.needsRewrap(2)).toBe(false);
    expect(rotated.seal(refreshToken, context).keyVersion).toBe(2);
  });

  it('informa claramente si falta la clave con la que se cifró', () => {
    const service = serviceWith({ 2: keyV2 }, 2);

    expect(() => service.open({ ciphertext: 'x'.repeat(64), keyVersion: 1 }, context)).toThrow(
      /No hay clave de cifrado para la versión 1/,
    );
  });

  it('hashea tokens opacos de forma determinista', () => {
    const hash = TokenCryptoService.hashOpaqueToken('refresh-abc');

    expect(hash).toHaveLength(64);
    expect(TokenCryptoService.hashOpaqueToken('refresh-abc')).toBe(hash);
    expect(TokenCryptoService.hashOpaqueToken('refresh-abd')).not.toBe(hash);
  });
});

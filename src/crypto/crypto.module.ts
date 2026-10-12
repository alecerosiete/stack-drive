import { Global, Module } from '@nestjs/common';
import { TokenCryptoService } from './token-crypto.service';

@Global()
@Module({
  providers: [TokenCryptoService],
  exports: [TokenCryptoService],
})
export class CryptoModule {}

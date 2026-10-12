import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfiguration } from './configuration';

/**
 * Expone la configuración validada a toda la aplicación.
 *
 * Es `@Global` porque los proveedores de Nest son locales a su módulo: sin
 * esto, cada módulo que inyecta `APP_CONFIG` tendría que importar este, y
 * olvidarlo en uno solo rompe el arranque.
 */
@Global()
@Module({
  providers: [
    {
      // La validación ocurre una sola vez, al construir el contenedor: si
      // falta una variable obligatoria, la aplicación no llega a escuchar.
      provide: APP_CONFIG,
      useFactory: () => loadConfiguration(),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}

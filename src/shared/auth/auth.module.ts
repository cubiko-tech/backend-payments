import { Global, Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'

import { ApiAuthGuard } from './api-auth.guard'

/**
 * Autenticación de la API: el guard y el `JwtService` que necesita.
 *
 * Vive acá y no dentro de un módulo de dominio porque lo usan superficies que no
 * tienen nada que ver entre sí —crédito, admin, checkout, suscripciones— y todas
 * necesitan lo mismo: resolver quién llama. Antes el guard vivía en
 * `CreditModule`, así que `AdminModule` lo importaba entero sólo para tomarlo y
 * se llevaba puesta la cola BullMQ `credit-run`, seis entidades sobre dos
 * conexiones, un processor y el cliente de buró. Cada módulo nuevo que quisiera
 * autenticar heredaba esa cola.
 *
 * `@Global()` porque los guards de `@UseGuards(Clase)` se instancian en el
 * contexto del módulo del CONTROLLER, no en el del módulo que los provee: sin
 * esto, cada módulo con un endpoint autenticado tendría que importar
 * `AuthModule` a mano y el olvido se manifiesta como un error de inyección en
 * runtime, no en compilación.
 *
 * `ClientRolesService` —la otra dependencia del guard— ya llega por
 * `ClientModule`, que también es global.
 */
@Global()
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET })],
  providers: [ApiAuthGuard],
  exports: [ApiAuthGuard, JwtModule],
})
export class AuthModule {}

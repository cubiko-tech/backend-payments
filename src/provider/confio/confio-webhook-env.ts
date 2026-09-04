/**
 * Lectura del entorno para el webhook de ConfioPagos.
 *
 * Módulo PURO: no loguea, no depende de Nest y recibe el entorno por parámetro
 * —con `process.env` por defecto— para que el llamador real no cambie y el spec
 * no tenga que ensuciar el entorno del runner.
 *
 * Vive aparte del módulo de firma A PROPÓSITO: `confio-webhook-signature.ts` es
 * puro sobre sus argumentos y no lee `process.env`; el que decide de dónde sale
 * la clave es el cableado, y esa decisión es lo que se prueba acá.
 */

/**
 * Clave compartida con ConfioPagos (`CONFIO_WEBHOOK_KEY`), o `null` si no está
 * configurada.
 *
 * `CHANGEME` cuenta como NO configurada: es el valor que `.env-template:76`
 * deja puesto hasta que el gerente de cuenta entregue el definitivo, y tomarlo
 * como clave real haría verificar firmas contra un secreto público. Es la misma
 * semántica del vecino `confio.provider.ts:110` (`token && token !== 'CHANGEME'`).
 *
 * NO se hace `trim()`: espejar al vecino vale más que inventar una regla más
 * estricta, y un secreto con espacios al borde es un secreto distinto.
 */
export function readConfioWebhookKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.CONFIO_WEBHOOK_KEY

  return key && key !== 'CHANGEME' ? key : null
}

// `isProductionEnv` se mudó a `shared/env/is-production` porque su tercer
// consumidor es el logger, y `shared/` no puede depender de un provider de pagos.
// Se re-exporta para no romper a quien ya la importaba desde acá.
export { isProductionEnv } from '../../shared/env/is-production'

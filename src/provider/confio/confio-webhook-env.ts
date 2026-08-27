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

/**
 * Dice si el proceso corre en producción.
 *
 * `ENV` LIDERA la disyunción porque es la grafía que este servicio usa de
 * verdad: `.env.schema:3` la declara `required` con `development|staging|production`,
 * `.env-template:1` la fija y `entrypoint.sh` ramifica sobre `$ENV`. Ni `GO_ENV`
 * ni `NODE_ENV` aparecen en la configuración del servicio.
 *
 * Las otras dos grafías se conservan para que este predicado nunca sea MÁS
 * DÉBIL que el que ya vive en `confio.provider.ts:511` (que sólo mira
 * `GO_ENV`/`NODE_ENV` y por eso da falso siempre acá — agujero preexistente,
 * anotado en INBOX.md, que NO se arregla en esta tarea).
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.ENV === 'production' || env.GO_ENV === 'production' || env.NODE_ENV === 'production'
  )
}

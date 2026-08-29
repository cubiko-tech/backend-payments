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
  return env.ENV === 'production' || env.GO_ENV === 'production' || env.NODE_ENV === 'production'
}

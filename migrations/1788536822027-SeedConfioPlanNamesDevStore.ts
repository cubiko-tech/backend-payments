import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Deja MAPEADOS los cuatro planes del store de pruebas, en vez de que cada
 * ambiente los llene a mano.
 *
 * Por qué existe: hasta el 2026-09-04 los `confioName` se escribían con un UPDATE
 * manual. Se hizo en local y nunca en dev, así que dev quedó con las cuatro filas
 * en `pending` y NINGUNA alta era posible —ni siquiera la de prueba—, mientras
 * todo parecía bien desplegado. Un dato que hay que repetir en cada base termina
 * faltando en alguna.
 *
 * ⚠️ POR QUÉ VA CONDICIONADA AL STORE, y no es paranoia: un `confioName` lleva el
 * store adentro (`stores/{store}/subscription-plans/{plan}`). Sembrar estos
 * valores en un ambiente que apunta a OTRO store le haría crear suscripciones
 * contra planes ajenos —o cobrar en el lugar equivocado—, y como ConfioPagos no
 * deja borrar ni editar planes, eso no se deshace. Por eso sólo escribe si
 * `CONFIO_STORE_ID` es exactamente el store al que pertenecen.
 *
 * Producción NO entra: tiene su propio store, sus propios planes y su propia
 * fila en HUMAN_ACTIONS. Ahí estas cuatro filas siguen en `pending` y el alta
 * falla ruidosa con `CONFIO_PLAN_NOT_CREATED`, que es lo correcto.
 *
 * ⚠️ TRAMPA DE LAS MIGRACIONES CONDICIONADAS, medida el 2026-09-04: si al correr
 * esto `CONFIO_STORE_ID` todavía no es el correcto, la migración NO escribe nada
 * pero TypeORM la registra igual como ejecutada, y no vuelve a intentarlo nunca.
 * O sea que un deploy con la variable mal deja el ambiente sin planes y con la
 * migración marcada como hecha. La verificación después de desplegar no es «¿corrió
 * la migración?» sino mirar la tabla:
 *   SELECT "currencyCode", "withTrial", "confioName" FROM confio_subscription_plan;
 * Si hay `NULL` donde debería haber un plan, hay que revertirla y volver a correrla.
 */
const STORE = '01KZBY100Z3HD2X997XE0DN8PW'

const PLANES: Array<{ currency: string; withTrial: boolean; plan: string }> = [
  { currency: 'COP', withTrial: true, plan: '01M0Z020DYMXKKDHHR4HAX916R' },
  { currency: 'USD', withTrial: true, plan: '01M0Z020PS0BFTTENSN78A3SRW' },
  { currency: 'COP', withTrial: false, plan: '01M1PEBWNMR9HRT0DD33C0S5F2' },
  { currency: 'USD', withTrial: false, plan: '01M1PEC4DWR62BVT76G98J7DXD' },
]

const nombre = (plan: string) => `stores/${STORE}/subscription-plans/${plan}`

export class SeedConfioPlanNamesDevStore1788536822027 implements MigrationInterface {
  name = 'SeedConfioPlanNamesDevStore1788536822027'

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (process.env.CONFIO_STORE_ID !== STORE) return

    for (const p of PLANES) {
      // `confioName IS NULL` es la otra mitad de la guarda: si alguien ya mapeó
      // esa fila a mano, esta migración NO la pisa. Sembrar es llenar un hueco,
      // no imponer un valor.
      await queryRunner.query(
        `UPDATE "confio_subscription_plan"
            SET "confioName" = $1, "status" = 'active', "updatedAt" = now()
          WHERE "planSlug" = 'dropi-roax'
            AND "currencyCode" = $2
            AND "withTrial" = $3
            AND "confioName" IS NULL`,
        [nombre(p.plan), p.currency, p.withTrial],
      )
    }
  }

  public async down(): Promise<void> {
    // NO-OP DELIBERADO. La primera versión ponía en NULL las filas que apuntaran a
    // estos planes, y al probarla borró TAMBIÉN las dos que ya estaban mapeadas a
    // mano desde antes: una siembra no puede distinguir «esto lo puse yo» de «esto
    // ya estaba con el mismo valor», así que revertir destruía trabajo ajeno.
    //
    // Y no hay nada que reparar: dejar el mapeo puesto no rompe nada —es el estado
    // correcto del ambiente—. Si de verdad hay que desmapear, es un UPDATE a mano y
    // una decisión, no el efecto colateral de un rollback.
  }
}

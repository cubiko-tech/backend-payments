import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Siembra `tax_config` para los países no-CO donde ya cobramos.
 *
 * Hasta ahora la tabla sólo tenía Colombia (`InitialSchema`), pero desde que el
 * alta resuelve el precio por el país de la marca, el impuesto se calcula con
 * ESE país y no con el del perfil de facturación. Una marca de México o de
 * Estados Unidos caía entonces en el fallback de `tax.service.ts:25-27`: **0% con
 * un `logger.warn`**. El número que sale es correcto, pero el camino no: no
 * distingue «este país no cobra este impuesto» de «nadie lo configuró», y esa
 * diferencia sólo se nota cuando alguien audita una factura.
 *
 * Los tres países vienen de `provider_config`, que YA es multipaís (CO, MX, US
 * con proveedores activos): son exactamente los países en los que hoy se puede
 * cobrar.
 *
 * Sobre los valores:
 *
 * - **MX — IVA 16%, no inclusivo.** Es la tasa general del IVA mexicano y el
 *   precio del catálogo está expresado sin impuesto, igual que en Colombia.
 * - **US — 0%.** Estados Unidos no tiene un impuesto federal al consumo; el
 *   sales tax es estatal y depende del nexo fiscal del vendedor, que no
 *   tenemos. Cero es la respuesta correcta HOY, y queda escrita como decisión
 *   en vez de emerger de un `if` que no encontró la fila.
 *
 * `ON CONFLICT DO NOTHING` sobre el índice único parcial de `country`: la
 * migración es idempotente y no pisa una tasa que alguien haya ajustado.
 * `down()` borra sólo las dos filas que esta migración escribió, y sólo si
 * siguen con el valor sembrado.
 */
export class SeedTaxConfigNonCo1787781410056 implements MigrationInterface {
  name = 'SeedTaxConfigNonCo1787781410056'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "tax_config" ("country", "taxName", "taxRate", "isInclusive", "isActive")
      VALUES
        ('MX', 'IVA', 0.1600, false, true),
        ('US', 'Sales tax', 0.0000, false, true)
      ON CONFLICT DO NOTHING
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "tax_config"
      WHERE ("country" = 'MX' AND "taxRate" = 0.1600)
         OR ("country" = 'US' AND "taxRate" = 0.0000)
    `)
  }
}

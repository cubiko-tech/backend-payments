import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Cambia la columna `provider` en wallets de enum a varchar.
 * Permite agregar proveedores dinámicamente desde provider_config sin migraciones.
 */
export class WalletProviderToVarchar1775900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Cambiar columna de enum a varchar manteniendo los datos existentes
    await queryRunner.query(`
      ALTER TABLE wallets
      ALTER COLUMN provider TYPE varchar(50)
      USING provider::text
    `)

    // Eliminar el tipo enum si ya no lo usa nadie más
    // (payment.provider aún lo usa, así que no eliminamos wallet_provider_enum)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallets
      ALTER COLUMN provider TYPE wallet_provider_enum
      USING provider::wallet_provider_enum
    `)
  }
}

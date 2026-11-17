import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddTokenGiftBatches1794300000000 implements MigrationInterface {
  name = 'AddTokenGiftBatches1794300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "token_gift_batches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "idempotencyKey" character varying(200) NOT NULL,
        "filterKind" character varying(20) NOT NULL,
        "filterBrandIds" jsonb,
        "amount" numeric(15,2) NOT NULL,
        "confirmedTotalTokens" numeric(15,2) NOT NULL,
        "reason" character varying(500) NOT NULL,
        "authorId" character varying(255) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "totalBrands" integer NOT NULL DEFAULT 0,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_token_gift_batches" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_token_gift_batches_idempotency_key" UNIQUE ("idempotencyKey")
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "token_gift_batch_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "batchId" uuid NOT NULL,
        "seq" integer NOT NULL,
        "brandId" character varying(255) NOT NULL,
        "walletId" uuid,
        "outcome" character varying(20) NOT NULL DEFAULT 'pending',
        "omitReason" character varying(20),
        "creditedAmount" numeric(15,2) NOT NULL DEFAULT 0,
        "transactionId" uuid,
        CONSTRAINT "PK_token_gift_batch_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_token_gift_batch_items_batch" FOREIGN KEY ("batchId")
          REFERENCES "token_gift_batches"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_token_gift_batch_items_batch_brand" UNIQUE ("batchId", "brandId")
      )
    `)
    await queryRunner.query(`
      CREATE INDEX "IDX_token_gift_batch_items_batch_outcome_seq"
      ON "token_gift_batch_items" ("batchId", "outcome", "seq")
    `)
    await queryRunner.query(`
      CREATE INDEX "IDX_token_gift_batch_items_batch_seq"
      ON "token_gift_batch_items" ("batchId", "seq")
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "token_gift_batch_items"`)
    await queryRunner.query(`DROP TABLE "token_gift_batches"`)
  }
}

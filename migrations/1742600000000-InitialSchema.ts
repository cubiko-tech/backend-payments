import { MigrationInterface, QueryRunner } from 'typeorm'

export class InitialSchema1742600000000 implements MigrationInterface {
  name = 'InitialSchema1742600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)

    // ===========================================
    // Enums
    // ===========================================
    await queryRunner.query(`CREATE TYPE "wallet_provider_enum" AS ENUM ('internal', 'dropi', 'stripe', 'mercadopago')`)
    await queryRunner.query(`CREATE TYPE "wallet_status_enum" AS ENUM ('active', 'frozen', 'closed')`)
    await queryRunner.query(`CREATE TYPE "transaction_type_enum" AS ENUM ('credit', 'debit')`)
    await queryRunner.query(`CREATE TYPE "transaction_status_enum" AS ENUM ('pending', 'completed', 'failed', 'reversed')`)
    await queryRunner.query(`CREATE TYPE "payment_provider_enum" AS ENUM ('stripe', 'mercadopago', 'dropi', 'wallet')`)
    await queryRunner.query(`CREATE TYPE "payment_status_enum" AS ENUM ('pending', 'processing', 'completed', 'failed', 'refunded', 'disputed')`)
    await queryRunner.query(`CREATE TYPE "payment_purpose_enum" AS ENUM ('plan_purchase', 'wallet_recharge', 'service_payment')`)
    await queryRunner.query(`CREATE TYPE "attempt_status_enum" AS ENUM ('success', 'failed', 'timeout')`)
    await queryRunner.query(`CREATE TYPE "subscription_status_enum" AS ENUM ('trial', 'active', 'past_due', 'cancelled', 'expired')`)
    await queryRunner.query(`CREATE TYPE "subscription_provider_enum" AS ENUM ('stripe', 'mercadopago', 'wallet', 'dropi')`)
    await queryRunner.query(`CREATE TYPE "subscription_event_type_enum" AS ENUM ('created', 'plan_changed', 'renewed', 'cancelled', 'expired', 'reactivated', 'payment_failed', 'payment_succeeded', 'trial_started', 'trial_ended')`)
    await queryRunner.query(`CREATE TYPE "payment_method_type_enum" AS ENUM ('card', 'bank_transfer', 'pse', 'nequi', 'wallet')`)
    await queryRunner.query(`CREATE TYPE "payment_method_status_enum" AS ENUM ('active', 'expired', 'removed')`)
    await queryRunner.query(`CREATE TYPE "webhook_status_enum" AS ENUM ('received', 'processing', 'processed', 'failed')`)
    await queryRunner.query(`CREATE TYPE "invoice_type_enum" AS ENUM ('invoice', 'credit_note')`)
    await queryRunner.query(`CREATE TYPE "invoice_status_enum" AS ENUM ('draft', 'issued', 'paid', 'void')`)
    await queryRunner.query(`CREATE TYPE "refund_reason_enum" AS ENUM ('customer_request', 'duplicate', 'dispute', 'service_issue', 'plan_downgrade')`)
    await queryRunner.query(`CREATE TYPE "refund_status_enum" AS ENUM ('pending', 'processing', 'completed', 'failed')`)
    await queryRunner.query(`CREATE TYPE "tax_id_type_enum" AS ENUM ('NIT', 'CC', 'CE', 'RFC', 'RUC', 'PASSPORT')`)
    await queryRunner.query(`CREATE TYPE "tax_regime_enum" AS ENUM ('responsable_iva', 'no_responsable', 'gran_contribuyente', 'simplificado')`)

    // ===========================================
    // 1. wallets
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "wallets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "brandId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "provider" "wallet_provider_enum" NOT NULL,
        "providerWalletId" character varying,
        "currency" character varying(3) NOT NULL,
        "balance" numeric(15,2) NOT NULL DEFAULT 0,
        "status" "wallet_status_enum" NOT NULL DEFAULT 'active',
        "metadata" jsonb,
        CONSTRAINT "PK_wallets" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_wallets_brand_provider_currency" ON "wallets" ("brandId", "provider", "currency")`)

    // ===========================================
    // 2. transactions
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "walletId" uuid NOT NULL,
        "brandId" character varying NOT NULL,
        "type" "transaction_type_enum" NOT NULL,
        "amount" numeric(15,2) NOT NULL,
        "balanceBefore" numeric(15,2) NOT NULL,
        "balanceAfter" numeric(15,2) NOT NULL,
        "status" "transaction_status_enum" NOT NULL DEFAULT 'completed',
        "category" character varying,
        "description" text,
        "referenceType" character varying,
        "referenceId" character varying,
        "metadata" jsonb,
        CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_transactions_wallet" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_transactions_wallet_date" ON "transactions" ("walletId", "createdAt" DESC)`)
    await queryRunner.query(`CREATE INDEX "IDX_transactions_brand_date" ON "transactions" ("brandId", "createdAt" DESC)`)
    await queryRunner.query(`CREATE INDEX "IDX_transactions_reference" ON "transactions" ("referenceType", "referenceId")`)

    // ===========================================
    // 3. payments
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "brandId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "walletId" uuid,
        "provider" "payment_provider_enum" NOT NULL,
        "providerPaymentId" character varying,
        "amount" numeric(15,2) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "status" "payment_status_enum" NOT NULL DEFAULT 'pending',
        "purpose" "payment_purpose_enum" NOT NULL,
        "purposeId" character varying,
        "checkoutUrl" text,
        "failureReason" text,
        "paidAt" TIMESTAMP WITH TIME ZONE,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "metadata" jsonb,
        CONSTRAINT "PK_payments" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_payments_brand_status_date" ON "payments" ("brandId", "status", "createdAt" DESC)`)
    await queryRunner.query(`CREATE INDEX "IDX_payments_provider_id" ON "payments" ("providerPaymentId") WHERE "providerPaymentId" IS NOT NULL`)
    await queryRunner.query(`CREATE INDEX "IDX_payments_pending" ON "payments" ("status") WHERE "status" = 'pending'`)

    // ===========================================
    // 4. payment_attempts
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "payment_attempts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "paymentId" uuid NOT NULL,
        "attemptNumber" integer NOT NULL,
        "provider" character varying,
        "providerResponseCode" character varying,
        "providerResponseMessage" text,
        "status" "attempt_status_enum" NOT NULL,
        "amount" numeric(15,2) NOT NULL,
        "metadata" jsonb,
        "attemptedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_payment_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payment_attempts_payment" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_payment_attempts_payment" ON "payment_attempts" ("paymentId", "attemptNumber")`)

    // ===========================================
    // 5. subscriptions
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "brandId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "planSlug" character varying NOT NULL,
        "status" "subscription_status_enum" NOT NULL DEFAULT 'trial',
        "walletId" uuid,
        "provider" "subscription_provider_enum" NOT NULL,
        "providerSubscriptionId" character varying,
        "currentPeriodStart" TIMESTAMP WITH TIME ZONE NOT NULL,
        "currentPeriodEnd" TIMESTAMP WITH TIME ZONE NOT NULL,
        "trialStart" TIMESTAMP WITH TIME ZONE,
        "trialEnd" TIMESTAMP WITH TIME ZONE,
        "autoRenew" boolean NOT NULL DEFAULT true,
        "cancelledAt" TIMESTAMP WITH TIME ZONE,
        "cancelReason" text,
        "lastPaymentId" uuid,
        "nextBillingDate" TIMESTAMP WITH TIME ZONE,
        "retryCount" integer NOT NULL DEFAULT 0,
        "metadata" jsonb,
        CONSTRAINT "PK_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subscriptions_brand" UNIQUE ("brandId")
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_subscriptions_billing" ON "subscriptions" ("status", "nextBillingDate") WHERE "status" IN ('active', 'past_due')`)

    // ===========================================
    // 6. subscription_events
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "subscription_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subscriptionId" uuid NOT NULL,
        "eventType" "subscription_event_type_enum" NOT NULL,
        "fromPlanSlug" character varying,
        "toPlanSlug" character varying,
        "fromStatus" character varying,
        "toStatus" character varying,
        "triggeredBy" character varying NOT NULL,
        "reason" text,
        "paymentId" uuid,
        "metadata" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscription_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_subscription_events_sub" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_subscription_events_sub_date" ON "subscription_events" ("subscriptionId", "createdAt" DESC)`)
    await queryRunner.query(`CREATE INDEX "IDX_subscription_events_type_date" ON "subscription_events" ("eventType", "createdAt" DESC)`)

    // ===========================================
    // 7. payment_methods
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "payment_methods" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "brandId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "providerMethodId" character varying NOT NULL,
        "type" "payment_method_type_enum" NOT NULL,
        "last4" character varying(4),
        "brand" character varying,
        "expiryMonth" integer,
        "expiryYear" integer,
        "isDefault" boolean NOT NULL DEFAULT false,
        "status" "payment_method_status_enum" NOT NULL DEFAULT 'active',
        "metadata" jsonb,
        CONSTRAINT "PK_payment_methods" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_payment_methods_brand_default" ON "payment_methods" ("brandId", "isDefault") WHERE "status" = 'active'`)

    // ===========================================
    // 8. webhook_events
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "webhook_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "provider" character varying NOT NULL,
        "eventType" character varying NOT NULL,
        "providerEventId" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "status" "webhook_status_enum" NOT NULL DEFAULT 'received',
        "processedAt" TIMESTAMP WITH TIME ZONE,
        "error" text,
        "retryCount" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_webhook_events" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_webhook_events_provider_id" UNIQUE ("providerEventId")
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_webhook_events_pending" ON "webhook_events" ("status") WHERE "status" IN ('received', 'failed')`)

    // ===========================================
    // 9. billing_profiles
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "billing_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "brandId" character varying NOT NULL,
        "legalName" character varying NOT NULL,
        "taxId" character varying NOT NULL,
        "taxIdType" "tax_id_type_enum" NOT NULL,
        "address" character varying,
        "city" character varying,
        "state" character varying,
        "country" character varying(2) NOT NULL,
        "postalCode" character varying,
        "email" character varying NOT NULL,
        "phone" character varying,
        "taxRegime" "tax_regime_enum",
        "dianResolutionNumber" character varying,
        "dianResolutionPrefix" character varying,
        "dianResolutionRangeFrom" integer,
        "dianResolutionRangeTo" integer,
        "dianResolutionDate" date,
        "dianResolutionExpiry" date,
        CONSTRAINT "PK_billing_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_billing_profiles_brand" UNIQUE ("brandId")
      )
    `)

    // ===========================================
    // 10. invoices
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "invoices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "brandId" character varying NOT NULL,
        "paymentId" uuid,
        "subscriptionId" uuid,
        "billingProfileId" uuid,
        "type" "invoice_type_enum" NOT NULL DEFAULT 'invoice',
        "creditNoteForId" uuid,
        "invoiceNumber" character varying NOT NULL,
        "subtotal" numeric(15,2) NOT NULL,
        "taxTotal" numeric(15,2) NOT NULL DEFAULT 0,
        "total" numeric(15,2) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "status" "invoice_status_enum" NOT NULL DEFAULT 'draft',
        "issuedAt" TIMESTAMP WITH TIME ZONE,
        "paidAt" TIMESTAMP WITH TIME ZONE,
        "dueAt" TIMESTAMP WITH TIME ZONE,
        "dianCufe" character varying,
        "pdfUrl" character varying,
        "metadata" jsonb,
        CONSTRAINT "PK_invoices" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_invoices_number" UNIQUE ("invoiceNumber"),
        CONSTRAINT "FK_invoices_billing_profile" FOREIGN KEY ("billingProfileId") REFERENCES "billing_profiles"("id") ON DELETE SET NULL
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_invoices_brand_date" ON "invoices" ("brandId", "createdAt" DESC)`)

    // ===========================================
    // 11. invoice_items
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "invoice_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "invoiceId" uuid NOT NULL,
        "description" text NOT NULL,
        "quantity" integer NOT NULL DEFAULT 1,
        "unitPrice" numeric(15,2) NOT NULL,
        "subtotal" numeric(15,2) NOT NULL,
        "taxRate" numeric(5,4) NOT NULL DEFAULT 0,
        "taxAmount" numeric(15,2) NOT NULL DEFAULT 0,
        "total" numeric(15,2) NOT NULL,
        "productType" character varying,
        "referenceType" character varying,
        "referenceId" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoice_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_invoice_items_invoice" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_invoice_items_invoice" ON "invoice_items" ("invoiceId")`)

    // ===========================================
    // 12. refunds
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "refunds" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "paymentId" uuid NOT NULL,
        "brandId" character varying NOT NULL,
        "amount" numeric(15,2) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "reason" "refund_reason_enum" NOT NULL,
        "status" "refund_status_enum" NOT NULL DEFAULT 'pending',
        "provider" character varying,
        "providerRefundId" character varying,
        "creditNoteId" uuid,
        "requestedBy" character varying NOT NULL,
        "approvedBy" character varying,
        "description" text,
        "metadata" jsonb,
        "processedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_refunds" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refunds_payment" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_refunds_payment" ON "refunds" ("paymentId")`)
    await queryRunner.query(`CREATE INDEX "IDX_refunds_brand_date" ON "refunds" ("brandId", "createdAt" DESC)`)
    await queryRunner.query(`CREATE INDEX "IDX_refunds_pending" ON "refunds" ("status") WHERE "status" = 'pending'`)

    // ===========================================
    // 13. tax_config
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "tax_config" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "country" character varying(2) NOT NULL,
        "taxName" character varying NOT NULL,
        "taxRate" numeric(5,4) NOT NULL,
        "isInclusive" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_tax_config" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_tax_config_country" ON "tax_config" ("country") WHERE "isActive" = true`)

    // Seed: IVA Colombia
    await queryRunner.query(`
      INSERT INTO "tax_config" ("country", "taxName", "taxRate", "isInclusive", "isActive")
      VALUES ('CO', 'IVA', 0.1900, false, true)
    `)

    // ===========================================
    // 14. wallet_balance_snapshots
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "wallet_balance_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "walletId" uuid NOT NULL,
        "balance" numeric(15,2) NOT NULL,
        "calculatedBalance" numeric(15,2) NOT NULL,
        "transactionCount" integer NOT NULL,
        "isConsistent" boolean NOT NULL,
        "snapshotAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_balance_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "FK_wallet_snapshots_wallet" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_wallet_snapshots_wallet_date" ON "wallet_balance_snapshots" ("walletId", "snapshotAt" DESC)`)
    await queryRunner.query(`CREATE INDEX "IDX_wallet_snapshots_inconsistent" ON "wallet_balance_snapshots" ("isConsistent") WHERE "isConsistent" = false`)

    // ===========================================
    // 15. audit_log
    // ===========================================
    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" character varying NOT NULL,
        "action" character varying NOT NULL,
        "entityType" character varying NOT NULL,
        "entityId" character varying NOT NULL,
        "changes" jsonb,
        "description" text,
        "ip" character varying,
        "userAgent" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_log" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_audit_log_entity" ON "audit_log" ("entityType", "entityId", "createdAt" DESC)`)
    await queryRunner.query(`CREATE INDEX "IDX_audit_log_user" ON "audit_log" ("userId", "createdAt" DESC)`)
    await queryRunner.query(`CREATE INDEX "IDX_audit_log_action" ON "audit_log" ("action", "createdAt" DESC)`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_balance_snapshots"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_items"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "refunds"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "invoices"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "billing_profiles"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_events"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_methods"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "subscription_events"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "subscriptions"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_attempts"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "transactions"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "tax_config"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "wallets"`)

    await queryRunner.query(`DROP TYPE IF EXISTS "tax_regime_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "tax_id_type_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "refund_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "refund_reason_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "invoice_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "invoice_type_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "webhook_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_method_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_method_type_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_event_type_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_provider_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "attempt_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_purpose_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_provider_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "transaction_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "transaction_type_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "wallet_status_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "wallet_provider_enum"`)
  }
}

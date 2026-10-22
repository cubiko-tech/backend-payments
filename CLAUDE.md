# CLAUDE.md — Mapa de `backend-payments`

Microservicio **NestJS 10 / TypeScript** para pagos, billeteras multi-moneda, suscripciones,
facturación electrónica (DIAN/Siigo) y originación/scoring de crédito. Persistencia en PostgreSQL
con separación lectura/escritura (`DBRead` / `DBWrite` en `src/orm/`) y colas/eventos en Redis
(BullMQ + Redis Streams). Puntos de entrada: `src/main.ts` y `src/app.module.ts`.

## Módulos de `src/`

| Carpeta | Qué hace |
| --- | --- |
| `src/admin/` | Endpoints `/admin` para gestión operativa de suscripciones, pagos, wallets, proveedores, transacciones, auditoría y activaciones de crédito. |
| `src/audit/` | Registro interno de auditoría (`audit_log`) sobre acciones y cambios de entidades del servicio. |
| `src/billing-profile/` | Perfiles de facturación por marca (`/billing-profile`), documentos legales y reglas fiscales por país. |
| `src/checkout/` | Orquestación extremo a extremo del checkout (`/checkout`: pago, suscripción, factura, DIAN y sincronización de roles/plan). |
| `src/client/` | Clientes HTTP hacia Auth, Platform y Roles (`backend-auth`, `backend-platform`, `backend-roles`), resolución de precios por país y downgrade de plan. |
| `src/credit/` | Scoring y originación de crédito (`/credit`): motor de score (`src/credit/domain/`), consulta a buró (`src/credit/bureau/`), insumos (`src/credit/client/`) y corridas BullMQ. |
| `src/dian/` | Emisión y consulta de facturación electrónica ante la DIAN (`/dian`) mediante el proveedor Siigo (`src/dian/providers/siigo.provider.ts`). |
| `src/event-bus/` | Publicación de eventos inter-servicio en Redis Streams (`EventBusService`). |
| `src/health/` | Probes públicos sin autenticación (`/health`, `/health/ready`, `/health/live`). |
| `src/invoice/` | Consultas de facturas e ítems (`/invoice`) y generación de PDF con PDFKit. |
| `src/metrics/` | Métricas financieras (`/admin/metrics`: MRR, ingresos, churn) y snapshots periódicos por cron. |
| `src/orm/` | Conexiones TypeORM de lectura (`src/orm/read.ts`), escritura/migraciones (`src/orm/write.ts`) y alta de base (`src/orm/createDatabase.ts`). |
| `src/payment/` | Creación y consulta de pagos e intentos de cobro (`/payment`). |
| `src/payment-method/` | CRUD de métodos de pago guardados por marca (`/payment-method`). |
| `src/provider/` | Registro y adaptadores de pasarelas (`ProviderFactory`): Stripe (`src/provider/stripe/`), MercadoPago (`src/provider/mercadopago/`), Dropi (`src/provider/dropi/`) y Confío (`src/provider/confio/`). |
| `src/refund/` | Solicitud, listado y procesamiento de reembolsos (`/refund`). |
| `src/shared/` | Guard de autenticación y permisos (`src/shared/auth/`), middleware (`src/shared/middleware/`), logger (`src/shared/logger/`), excepciones (`src/shared/exception/`), entidad base (`src/shared/entities/`) y entorno (`src/shared/env/`). |
| `src/subscription/` | Ciclo de vida de suscripciones (`/subscription`), trials y cancelaciones de Confío, precios enterprise e historial de eventos. |
| `src/tasks/` | Tareas programadas (cron) para expiración de suscripciones, reintentos de cobro y snapshots. |
| `src/tax/` | Cálculo de impuestos aplicables según la configuración activa por país (`tax_config`). |
| `src/transaction/` | Entidad de movimientos contables (`transactions`, crédito/débito) asociados a cada wallet. |
| `src/wallet/` | Billeteras por marca y moneda (`/wallet`), recargas, débitos, transferencias y snapshots de saldo. |
| `src/webhook/` | Recepción y validación de webhooks de pasarelas (`/webhook`) y cola BullMQ de reintentos (`webhook-retry`). |

## Riesgos y documentación

- **Riesgos activos del servicio**: [`docs/RIESGOS.md`](docs/RIESGOS.md) (fuente única; no copiar sus entradas aquí).
- **Diseño y contratos**:
  - [`docs/PLAN_PAYMENTS_COMPLETO.md`](docs/PLAN_PAYMENTS_COMPLETO.md) — diseño general del servicio de pagos.
  - [`docs/DISEÑO_SCORING_CREDITO.md`](docs/DISEÑO_SCORING_CREDITO.md) y [`docs/PLAN_LOOP_PLATA_CREDITO.md`](docs/PLAN_LOOP_PLATA_CREDITO.md) — motor de scoring y flujo de crédito.
  - [`docs/CONTRATO_INTEGRACION_DROPI_CREDITO.md`](docs/CONTRATO_INTEGRACION_DROPI_CREDITO.md) y [`docs/CREDIT_SCORING_FRONTEND.md`](docs/CREDIT_SCORING_FRONTEND.md) — contratos de integración de crédito.
  - [`docs/MIGRACION_BULLMQ_PAYMENTS.md`](docs/MIGRACION_BULLMQ_PAYMENTS.md) — colas en BullMQ.
  - [`docs/REVISION_TRIAL_CONFIO_2026-06-30.md`](docs/REVISION_TRIAL_CONFIO_2026-06-30.md) — revisión del trial de Confío.

## Operación y pruebas

- Base de datos y semillas: `migrations/` y `fixtures/`.
- Hooks y scripts: `scripts/commit-msg.sh`, `Makefile` y `package.json`.
- Pruebas unitarias y de contrato: `npm test` (Jest con `--maxWorkers=2` en el contenedor del servicio).

## Carga en `agy` 1.4

`agy` 1.4 (comprobado en `agy --version` = 1.4.4, inspeccionando el bloque `<user_rules>` inyectado al
abrir sesión y la guía integrada de `agy-customizations`, sección *Directory-Based Rules*) descubre y
carga automáticamente `AGENTS.md` por directorio, no `CLAUDE.md`. Por eso [`AGENTS.md`](AGENTS.md)
apunta a este mapa sin duplicarlo.

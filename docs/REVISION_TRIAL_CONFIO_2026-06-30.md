# Revisión — Trial gratuito + ConfioPagos (backend-payments)

> **Nota de alcance:** esta revisión cubre el área completa de la feature
> (commits `ce87ac0~1..c514aca`, batch del 2026-06-22 sobre `feat/credit-scoring`),
> NO el delta puntual de un PR específico. Se deja archivada para retomar.
> Hecha el 2026-06-30. Rama en `c514aca` (== `origin/feat/credit-scoring`).

## Contenido revisado
- `feat(subscription)`: trial gratuito con auto-conversión
- `feat(payments)`: proveedor ConfioPagos (links one-shot) + reconciliación
- `fix(config)`: `REDIS_PASSWORD` a BullMQ
- docs frontend del credit score

**Veredicto:** 🟡 mergear DESPUÉS de los bloqueantes. Riesgos concretos de plata.

## 🔴 Bloqueantes

### 1. `completeExternalPayment` no atómico → doble factura / wallet / plan
`checkout.service.ts:334`. Tres caminos llaman directo: webhook (`webhook.service.ts:242`),
cron `reconcileExternalPayments` (cada 5 min), `GET /checkout/return`. Guarda
`if (status===COMPLETED) return` read-then-write sin lock. Dos lecturas `PENDING`
concurrentes → factura + DIAN + `walletService.credit` + plan duplicados.
**Fix:** compare-and-set atómico — `UPDATE payment SET status='completed' WHERE id=$1 AND status='pending' RETURNING *`; seguir solo si `affected===1`.

### 2. Webhook fail-open + confía en `status` del payload
`confio.provider.ts:171` + `webhook.service.ts:209`. `validateWebhookSignature`
devuelve `true` si no hay token y `NODE_ENV`/`GO_ENV` ≠ `production` (común en
compose). En ese estado `POST /webhook/confio` con `{"data":{"status":"FUNDED","correlationId":"<paymentId>"}}`
marca pagado cualquier pago, sin pasar por ConfioPagos. Completación basada solo
en el `status` del body, sin re-verificar con `getPaymentStatus`.
**Fix:** (a) fallar cerrado si no hay secreto (gate explícito `CONFIO_WEBHOOK_INSECURE_DEV=true`, nunca por ausencia de `NODE_ENV`); (b) re-verificar estado real antes de completar.

### 3. Re-emisión de links Confío sin idempotencia → doble cobro
`tasks.service.ts:60,190,237`. Cada renovación/reintento crea nuevo `Payment` +
nuevo link sin expirar los `PENDING` previos del mismo período. Pagar un link
viejo completa un pago real y extiende la suscripción.
**Fix:** marcar `PENDING` confío previos como `EXPIRED`/`CANCELED` antes de emitir;
idempotency key por `subscriptionId + período`.

## 🟠 Importantes

### 4. Cobros del cron pierden identidad del comprador
`tasks.service.ts:50` → `confio.provider.ts:200`. `issueExternalCharge` no pasa
`buyer` → fallback `pagos@cubiko.co` + teléfono hardcodeado `+573215786325`.
Recibos/notificaciones de Confío mal dirigidos e inconciliables.
**Fix:** resolver email/teléfono reales del billing profile y pasarlos a `processCheckout`.

### 5. `startTrial` no transaccional + contrato de error inconsistente
`subscription.service.ts:88`. `save` + evento + `assignPlanToBrand` (HTTP) sin
transacción. Si falla roles, queda TRIAL sin plan asignado, y devuelve `{error}`
con HTTP 200 (vs `create`/`cancel` que lanzan). Filtra `error.message` crudo.
**Fix:** envolver en query runner `DBWrite`, compensar o lanzar `RequestException`.

### 6. Endpoints nuevos sin authz propia (IDOR)
`checkout.controller.ts:30`, `subscription.controller.ts:39`. `GET /checkout/return`
consulta estado/plan de cualquier `paymentId` y fuerza liquidación;
`POST /subscription/trial` asigna plan pago a cualquier `brandId`/`userId` del body.
Siguen el patrón `@UseGuards()` vacío preexistente (auth en gateway) → Medium,
pero High si la ruta es alcanzable sin identidad verificada.
**Fix:** derivar `userId`/`brandId` del principal autenticado y validar ownership.

## 🟡 Menores / nits
- Evento `PAYMENT_FAILED` al emitir un link exitoso → contamina dunning/analytics. Usar `PAYMENT_LINK_ISSUED`. (`tasks.service.ts:79`)
- `amountCents = amount × 100` para COP (moneda sin centavos) — verificar contra API Confío, podría cobrar 100×. Sin test del contrato.
- Contradicción formato `name`: `getPaymentStatus` asume prefijo `stores/` pero spec modela `payments/abc123` → ruta `…/payments/payments/abc123`. Sin test. (`confio.provider.ts:104`)
- Crons con `find()` sin `take` + HTTP secuencial → backlog en memoria. Batchear.
- Bordes sin tipo: `confioFetch(): any`, `as any`, `@Body() data` sin DTO/class-validator.
- `JSON.parse(text)` lanza `SyntaxError` opaco ante HTML del gateway; sin retry en GET idempotente.
- Confío `ACTIVE → PAST_DUE` cada ciclo hasta que el webhook revierte → falsos positivos en dashboards.
- Teléfono fallback hardcodeado vs email por env (`CONFIO_FALLBACK_PHONE`).

## ✅ Verificado y correcto
- Sin secretos reales commiteados (`CHANGEME` + `sensitive: true`); token nunca logueado.
- `timingSafeEqual` con check de longitud.
- Migración `1782146588230` segura: `provider_config.provider` es `varchar`, no el enum → `ALTER TYPE … ADD VALUE` no rompe en PG16.
- Specs nuevos significativos (request shape, `amountCents`, mapa de estados, normalización de teléfono, 4 ramas de trial).

## Cobertura faltante (tests)
- Rama `confio` del webhook (`correlationId` vs `name` fallback; completed/failed/intermediate).
- Idempotencia de `completeExternalPayment` bajo doble disparo (Bloqueante #1).
- `reconcilePayment` (return page) y ruta de id `undefined`.
- Ruta `{error}` de `startTrial` (Importante #5).
- `amountCents` para COP cero-decimal.

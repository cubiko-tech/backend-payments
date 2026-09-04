# Plan: Sistema Completo de Pagos, Wallets, Suscripciones y Roles

## Contexto

backend-payments ya existe con una base sólida: 15 tablas, ~48 endpoints, 3
proveedores (Stripe, MercadoPago, Dropi), wallets multi-proveedor,
suscripciones, facturación con DIAN/Siigo, y webhooks. Sin embargo tiene gaps
críticos: los precios de planes están hardcodeados, no hay validación de firma
en webhooks, la integración con roles es parcial (solo asigna plan al pagar, no
lo remueve al cancelar/expirar), no hay balance global de wallets, no hay
sistema de admin para gestión de suscripciones, y faltan métricas de negocio.

El objetivo es completar el sistema para que:
1. Los pagos controlen totalmente el ciclo de vida de planes/permisos
2. Las wallets sean flexibles (múltiples, con balance global)
3. Los proveedores sean totalmente desacoplados y extensibles
4. La facturación soporte múltiples países
5. El admin tenga visibilidad completa del negocio
6. Haya métricas de comportamiento de compra

---

## Estado actual vs objetivo

| Área | Estado actual | Objetivo |
|------|--------------|----------|
| Wallets | Multi-proveedor, sin balance global | Balance global + wallets personalizadas + transferencias |
| Providers | Interface desacoplada, webhook sin firma | Registry pattern + firma validada + fácil agregar nuevo |
| Roles | Solo asigna plan al pagar (fire-and-forget) | Ciclo completo: asignar, renovar, cancelar, expirar |
| Admin | 7 endpoints básicos (adjust, freeze, audit) | Dashboard completo: expiraciones, cobros, pricing, métricas |
| Facturación | Colombia/DIAN vía Siigo | Multi-país con requisitos legales configurables |
| Notificaciones | No existe | Emails de pago, expiración, dunning |
| Métricas | No existe | Revenue, churn, LTV, comportamiento de compra |
| Precios | Hardcodeados en checkout.service.ts | Dinámicos desde backend-roles (plan_prices) |
| Webhooks | Sin validación de firma (3 TODOs) | Firma validada por proveedor |

---

## Fases de implementación (orden de prioridad)

### Fase 1: Seguridad y correcciones críticas
**Prioridad: BLOQUEANTE — hacer antes de producción**

#### 1.1 Validación de firma de webhooks
- **Archivos**: `src/webhook/webhook.service.ts`, `src/provider/stripe/stripe.webhook.ts`, `src/provider/mercadopago/mercadopago.webhook.ts`, `src/provider/dropi/dropi.webhook.ts`
- Stripe: `stripe.webhooks.constructEvent(payload, sig, webhookSecret)`
- MercadoPago: HMAC-SHA256 con `MP_WEBHOOK_SECRET`
- Dropi: verificar según su documentación (HMAC o token)
- Rechazar webhooks con firma inválida (401)
- Agregar header parsing y raw body access en el controller

#### 1.2 Precios dinámicos desde backend-roles
- **Archivos**: `src/checkout/checkout.service.ts` (líneas 40-45 hardcoded PLAN_PRICES), `src/tasks/tasks.service.ts` (línea 267)
- Crear `src/client/client-roles.service.ts` que consulte `GET /v1/plan` con caché de 5 minutos
- Reemplazar constante PLAN_PRICES por llamada al cliente
- Fallback: si roles no responde, usar último precio cacheado
- Para Dropi batch charges: mismo cliente

#### 1.3 Corrección de DEFAULT_USER_PLAN (YA HECHO)
- `backend-auth/src/client/service/auth/client-auth-roles.service.ts`: `user_individual` → `free`
- Migración en backend-roles para relaciones M:M y asignación a usuarios existentes

---

### Fase 2: Integración completa Payments ↔ Roles
**Prioridad: ALTA — el core del negocio**

#### 2.1 Ciclo completo de plan en backend-roles
- **Archivos backend-payments**:
  - `src/checkout/checkout.service.ts`: ya llama `assignPlanInRoles()` al pagar
  - `src/subscription/subscription.service.ts`: agregar `removePlanInRoles()` al cancelar
  - `src/tasks/tasks.service.ts`: agregar `removePlanInRoles()` al expirar suscripción
- **Archivos backend-roles**:
  - `src/data/brand-permission/brand-permission.controller.ts`: endpoint DELETE ya existe
  - Agregar propagación de `expiresAt` al asignar plan a marca
- Flujo completo:
  ```
  Pago exitoso → POST /v1/brand/{id}/plan/{planId} (con expiresAt)
  Renovación  → PATCH /v1/brand/{id}/plan/{planId} (extender expiresAt)
  Cancelación → DELETE /v1/brand/{id}/plan/{planId}
  Expiración  → DELETE /v1/brand/{id}/plan/{planId}
  ```

#### 2.2 Consumer de eventos en backend-roles
- **Archivo nuevo**: `backend-roles/src/event-bus/event-bus.consumer.ts`
- Consumir stream `events:payments`:
  - `subscription.expired` → remover plan de marca
  - `subscription.renewed` → extender expiresAt
  - `payment.completed` (purpose=plan_purchase) → asignar plan
- Redundancia: HTTP síncrono + evento async (el evento es backup si HTTP falla)

#### 2.3 Precios de planes enterprise personalizados
- **Tabla nueva**: `enterprise_pricing` en backend-payments
  ```sql
  enterprise_pricing (id, brandId UNIQUE, monthlyPrice, currency, negotiatedBy, validUntil, notes, metadata)
  ```
- **Migración**: `backend-payments/migrations/XXXX-AddEnterprisePricing.ts`
- **Endpoint admin**: `POST/PATCH /admin/enterprise-pricing/:brandId`
- Al hacer checkout de plan enterprise: consultar esta tabla primero, si no hay → precio estándar
- El precio aparece en el dashboard del usuario vía API

---

### Fase 3: Multi-wallet mejorada
**Prioridad: ALTA — diferenciador del producto**

#### 3.1 Balance global (suma de todas las wallets)
- **Archivo**: `src/wallet/wallet.service.ts`
- Nuevo método: `getGlobalBalance(brandId)` → suma balances de todas las wallets activas, agrupado por currency
- **Endpoint**: `GET /v1/wallet/global-balance?brandId=...`
- Response: `{ balances: [{ currency: "COP", total: 1500000, wallets: [...] }] }`

#### 3.2 Wallets personalizadas del usuario
- Permitir crear wallets con provider=INTERNAL y un `label` personalizado
- **Cambio en entidad**: agregar campo `label` (varchar, nullable) a `wallets`
- **Migración**: `ALTER TABLE wallets ADD COLUMN label varchar`
- El usuario puede crear wallets como "Publicidad", "Reserva", "Meta Ads" etc.
- Restricción: máximo 10 wallets por marca

#### 3.3 Transferencias entre wallets
- **Servicio nuevo**: `src/wallet/wallet-transfer.service.ts`
- **Endpoint**: `POST /v1/wallet/transfer`
  ```json
  { "fromWalletId": "...", "toWalletId": "...", "amount": 50000, "description": "..." }
  ```
- Ambas wallets deben ser de la misma marca y misma moneda
- Transacción atómica: pessimistic lock en ambas wallets
- Crear 2 transacciones: DEBIT en origen, CREDIT en destino
- Category: `transfer_out` / `transfer_in`, referenceType: `transfer`

#### 3.4 Congelar/cerrar wallets (implementar lógica existente)
- **Archivo**: `src/wallet/wallet.service.ts`
- El campo `status` ya existe (ACTIVE/FROZEN/CLOSED) pero no se usa
- `freezeWallet(id)`: status=FROZEN, bloquear débitos (créditos permitidos)
- `closeWallet(id)`: status=CLOSED, requiere balance=0, bloquear todo
- Admin endpoint ya existe: `POST /admin/wallet/:id/freeze`

---

### Fase 4: Proveedores de pago desacoplados
**Prioridad: MEDIA — ya funciona, mejorar extensibilidad**

#### 4.1 Provider Registry Pattern
- **Archivo**: `src/provider/provider.factory.ts` (ya existe como factory)
- Refactorizar a registry: cada provider se auto-registra
- `PaymentProviderRegistry.register('stripe', StripeProvider)`
- Los providers se cargan dinámicamente según env vars configuradas
- Agregar provider para Wompi (Colombia), PayU, etc. en el futuro solo requiere un módulo nuevo

#### 4.2 Webhook retry mejorado
- **Archivo**: `src/webhook/webhook.service.ts`
- Usar Bull queue para reintentos de webhooks fallidos
- 3 reintentos con backoff exponencial: 1min, 5min, 30min
- Dead letter queue para webhooks que fallan 3 veces
- Dashboard admin: `GET /admin/webhooks/failed`

#### 4.3 Configuración de proveedores por país
- **Tabla nueva**: `provider_config`
  ```sql
  provider_config (id, country, provider, isActive, priority, metadata)
  ```
- Permite configurar qué proveedores están disponibles por país
- Ejemplo: CO → [Stripe, MercadoPago, Dropi], MX → [Stripe, MercadoPago], US → [Stripe]
- El checkout muestra solo proveedores disponibles para el país de la marca

---

### Fase 5: Facturación multi-país
**Prioridad: MEDIA — Colombia funciona, expandir gradualmente**

#### 5.1 Configuración de requisitos legales por país
- **Tabla nueva**: `country_billing_config`
  ```sql
  country_billing_config (
    id, country, countryName,
    taxIdRequired, taxIdTypes (jsonb),
    taxRegimeRequired, taxRegimes (jsonb),
    electronicInvoiceRequired,
    electronicInvoiceProvider,
    requiredFields (jsonb),
    legalDocuments (jsonb),
    invoicePrefix, invoiceFormat,
    isActive
  )
  ```
- Seed inicial: Colombia (completo), México (parcial), US (mínimo)

#### 5.2 Provider de facturación electrónica extensible
- **Ya existe**: `src/dian/` con interface DianProvider + SiigoProvider + MockProvider
- Renombrar módulo: `dian/` → `electronic-invoice/` (más genérico)
- Mantener DianProvider como implementación de una interface `ElectronicInvoiceProvider`
- Agregar SATProvider para México (futuro)
- Factory que selecciona provider según `country_billing_config.electronicInvoiceProvider`

#### 5.3 Validación de billing profile por país
- **Archivo**: `src/billing-profile/billing-profile.service.ts`
- Al crear/actualizar billing profile, validar campos según `country_billing_config`
- Ejemplo CO: NIT/CC obligatorio, régimen fiscal obligatorio, dirección completa
- Ejemplo US: solo nombre, dirección, tax_id opcional

#### 5.4 Documentos legales por marca
- **Tabla nueva**: `brand_legal_documents`
  ```sql
  brand_legal_documents (id, brandId, country, documentType, documentUrl, status, verifiedAt, verifiedBy)
  ```
- Endpoint: `POST /v1/billing-profile/:brandId/documents` (upload)
- Endpoint: `GET /v1/billing-profile/:brandId/documents`
- Admin: `POST /admin/documents/:id/verify`

---

### Fase 6: Panel admin completo
**Prioridad: ALTA — necesario para operaciones del negocio**

#### 6.1 Dashboard de suscripciones
- Nuevos endpoints:
  - `GET /admin/subscriptions/expiring?days=7` — marcas por expirar en N días
  - `GET /admin/subscriptions/past-due` — marcas con pago pendiente/fallido
  - `GET /admin/subscriptions/summary` — resumen por plan y estado
  - `POST /admin/subscription/:id/extend` — extender manualmente

#### 6.2 Gestión de cobros
- `GET /admin/payments/pending` — pagos pendientes de completar
- `GET /admin/payments/failed` — pagos fallidos recientes
- `POST /admin/payments/:id/retry` — reintentar cobro manualmente
- `GET /admin/dropi/batch-status` — estado del último batch de Dropi

#### 6.3 Pricing enterprise por marca
- `GET /admin/enterprise-pricing` — listar precios enterprise personalizados
- `POST /admin/enterprise-pricing/:brandId` — crear/actualizar precio
- `DELETE /admin/enterprise-pricing/:brandId` — volver a precio estándar

#### 6.4 Gestión de wallets
- `GET /admin/wallets/summary` — total de dinero en el sistema por proveedor y moneda
- `GET /admin/wallets/inconsistent` — wallets con reconciliación fallida

---

### Fase 7: Notificaciones
**Prioridad: MEDIA — mejora UX significativamente**

#### 7.1 Eventos de notificación vía Redis Streams
- Publicar eventos que backend-processes consume:
  - `notification.payment_success`, `notification.payment_failed`
  - `notification.subscription_expiring`, `notification.subscription_expired`
  - `notification.invoice_ready`

#### 7.2 Cron de alertas de expiración
- Nuevo cron diario: `sendExpirationWarnings()` (7, 3, 1, 0 días antes)

#### 7.3 Dunning workflow (cobros fallidos)
- Secuencia automática: notificar en cada reintento + expiración final

---

### Fase 8: Métricas y analytics
**Prioridad: MEDIA-BAJA — valor alto para el negocio pero no bloquea operación**

#### 8.1 Endpoints de métricas admin
- `GET /admin/metrics/revenue`, `/churn`, `/ltv`, `/mrr`, `/arpu`, `/conversion`, `/payment-methods`, `/retention`

#### 8.2 Snapshots periódicos para métricas históricas
- Tabla `metrics_snapshots` + cron diario

---

## Resumen de orden de ejecución

| # | Fase | Esfuerzo | Dependencias |
|---|------|----------|-------------|
| 1 | Seguridad (webhook firma + precios dinámicos) | 2-3 días | Ninguna |
| 2 | Integración Payments ↔ Roles | 3-4 días | Fase 1 (precios) |
| 3 | Multi-wallet mejorada | 2-3 días | Ninguna (paralela con Fase 2) |
| 4 | Proveedores desacoplados | 2-3 días | Fase 1 (webhooks) |
| 5 | Facturación multi-país | 4-5 días | Fase 4 (providers) |
| 6 | Panel admin completo | 3-4 días | Fases 2+3 (datos disponibles) |
| 7 | Notificaciones | 2-3 días | Fase 2 (eventos) |
| 8 | Métricas y analytics | 3-4 días | Fase 6 (admin) |

---

## Tablas nuevas a crear

1. `enterprise_pricing` (Fase 2.3) — Precios enterprise personalizados por marca
2. `country_billing_config` (Fase 5.1) — Requisitos legales y fiscales por país
3. `brand_legal_documents` (Fase 5.4) — Documentos legales subidos por marca
4. `provider_config` (Fase 4.3) — Proveedores de pago disponibles por país
5. `metrics_snapshots` (Fase 8.3) — Snapshots diarios de métricas

---

## Archivos críticos existentes

### backend-payments
- `src/checkout/checkout.service.ts` — Orquestador principal, precios hardcodeados (L40-45)
- `src/provider/provider.interface.ts` — Interface de proveedores
- `src/provider/provider.factory.ts` — Factory de proveedores
- `src/webhook/webhook.service.ts` — Webhooks sin validación de firma
- `src/provider/stripe/stripe.webhook.ts` — TODO firma (L32)
- `src/provider/mercadopago/mercadopago.webhook.ts` — TODO firma (L45)
- `src/provider/dropi/dropi.webhook.ts` — TODO firma (L58)
- `src/wallet/wallet.service.ts` — Wallet con lock pessimistic
- `src/subscription/subscription.service.ts` — Lifecycle de suscripciones
- `src/tasks/tasks.service.ts` — 12 cron jobs (incluye `expireCancelledSubscriptions`, el retiro del plan al vencer el acceso pagado)
- `src/event-bus/event-bus.service.ts` — Redis Streams publisher
- `src/dian/` — Facturación electrónica (Siigo + Mock)
- `src/invoice/invoice-pdf.service.ts` — Generación PDF

### backend-roles
- `src/data/brand-permission/brand-permission.controller.ts` — Endpoints de plan por marca
- `src/cqrs/commands/assign-plan-to-user.handler.ts` — Cascada plan→rol→servicio→permiso
- `fixtures/core/04-plans.yml` — Definición de planes (actualizado con relaciones M:M)

### backend-auth
- `src/client/service/auth/client-auth-roles.service.ts` — Asignación de plan al registrar (corregido: free)

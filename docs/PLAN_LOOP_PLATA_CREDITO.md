# Plan de implementación — Loop de plata del crédito (lado Roax)

> Estado: **listo para implementar.** Diagnóstico y diseño cerrados; este doc es la
> fuente para construir en esta o cualquier sesión futura sin perder detalle.
> Marcar `[x]` a medida que se completa cada paso.
>
> **Qué es:** la mitad Roax del crédito — las entidades del préstamo, la saga de
> desembolso, el ingest de neteo y la conciliación. El scoring/pre-aprobado YA
> existe. La mitad Dropi (caja) la construye Dropi contra el contrato.
>
> **Docs relacionados (leer antes de empezar):**
> - `DISEÑO_SCORING_CREDITO.md` — motor de scoring (ya implementado).
> - `CONTRATO_INTEGRACION_DROPI_CREDITO.md` — los 4 endpoints Dropi↔Roax, idempotencia, EP4 y la fórmula de cupo §6.1.
> - `PLAN_PAYMENTS_COMPLETO.md` — contexto del servicio.

---

## 1. Modelo de negocio (resumen de 30 segundos)

Dropi adelanta plata sobre su propia cartera COD al **Dropi Wallet** del merchant;
recupera neteando de esa misma cartera. **Dropi es prestamista de récord
(factoring); Roax origina, underwritea, aprueba y lleva el libro contable.** La
plata se mueve Dropi→Dropi; **Roax nunca custodia caja**. Por eso el ledger de la
deuda son las entidades `loan` + `loan_repayment`, NO el `wallet` de Roax.

## 2. Decisiones tomadas (no re-debatir — ver contrato D1/D2)

| # | Decisión |
|---|---|
| D1 | Prestamista de récord = **Dropi** (anticipo sobre cartera / factoring). Roax cobra fee sobre la comisión, no interés. Requiere firma legal financiero (usura). |
| D2 | Dropi Wallet **líquido + etiquetado "anticipo de pauta"**. Control de riesgo = **sizing contra cartera (§6.1)**, no fencing del wallet. |
| D3 | Aprobación **manual** en el admin de Roax (no auto-aprobado en el piloto). |
| D4 | Repago **continuo por neteo** (`NETTING_RATE` 50% de cada liquidación). Auto-netting (EP3) como principal; botón manual (EP2) como respaldo. |
| D5 | El **wallet de Roax NO se usa para caja.** Source of truth de la deuda = `loan`/`loan_repayment`. Filas `Transaction` informativas opcionales solo para reporting unificado. |

## 3. Lo que ya existe vs lo que falta

| Pieza | Estado | Ubicación / acción |
|---|---|---|
| Scoring + pre-aprobado (`credit_score` snapshot inmutable) | ✅ | `src/credit/` — reusar tal cual |
| Insumos Meta×Dropi (`POST /v1/metrics/credit-inputs/batch`) | ✅ | `backend-processes/src/credit/` |
| Wallet + ledger (`credit`/`debit`/`transfer`, lock pesimista) | ✅ | `src/wallet/` — patrón de lock a imitar, NO para caja del préstamo |
| Event bus (Redis Streams) | ✅ con bug | `src/event-bus/` — usar **con outbox** |
| Entidades préstamo + saga + ingest + conciliación | ❌ | **este plan** |
| Cliente Dropi (EP1/EP2/EP4) + mock | ❌ | este plan |
| Sizing de cupo (EP4 + §6.1) | ❌ | este plan |

## 4. Principios de implementación (vienen de bugs ya cometidos en el repo)

1. **Migraciones con timestamp real de 13 dígitos** (`Date.now()`), nunca redondeado. Regla del proyecto.
2. **Outbox transaccional** para eventos: escribir el evento en la MISMA TX que el cambio de estado; un worker lo publica después. NO `eventBus.publish()` post-commit (bug A4 del checkout `checkout.service.ts:252`).
3. **Saga con compensación** en el desembolso: no marcar `loan` activo hasta que Dropi confirme caja; si falla, revertir a estado seguro (bug A3 del checkout `checkout.service.ts:227`).
4. **Idempotencia en todo borde de plata**: `idempotencyKey = loanId` (desembolso), `settlementRef`/`externalId` únicos (repago). Replays no duplican.
5. **Lock pesimista** sobre `loan` al aplicar repagos (mismo patrón que `wallet.service.ts:104`).
6. **`timingSafeEqual`** (longitudes igualadas) en el server-token del endpoint inbound EP3 — corrige el flaw S5; NO `token !== expected`. Token dedicado por integración, no `ACCESS_SERVER` compartido.
7. **Snapshots inmutables**: `loan.termsSnapshot` congela términos aceptados (monto, comisión, IP, timestamp), como hace `credit_score` con sus inputs.
8. **Re-score fresco al pedir**, nunca desembolsar contra pre-aprobado viejo; re-aplicar veto ROAS en el request.

---

## 5. Modelo de datos

Todas extienden `Content` (uuid + timestamps), `decimal(15,2)`, `jsonb` para snapshots. En `src/credit/entities/`.

### 5.1 `credit_line` — facilidad pre-aprobada/aceptada por marca
```ts
@Entity('credit_line')
@Index(['brandId'], { unique: true })   // 1 línea viva por marca
class CreditLine {
  brandId: string
  status: 'offered' | 'accepted' | 'active' | 'suspended' | 'closed'
  tier: string
  approvedAmount: number        // cupo por desembolso (resultado del sizing §6.1)
  commissionRate: number        // 0.035, etc.
  weeklyQuota: number           // 3 × approvedAmount
  currency: string              // 'COP'
  scoreId: string               // credit_score que la respalda
  termsSnapshot: jsonb
  acceptedAt: timestamptz | null
  acceptedBy: string | null     // userId + IP en snapshot
}
```

### 5.2 `loan` — préstamo vivo (un drawdown)
```ts
@Entity('loan')
@Index(['brandId', 'status'])
class Loan {
  creditLineId: string
  brandId: string
  scoreId: string               // score FRESCO al momento del drawdown
  status: 'pending_approval' | 'approved' | 'disbursing' | 'active'
        | 'repaying' | 'settled' | 'defaulted' | 'written_off' | 'cancelled'
  principal: number
  commission: number            // principal × commissionRate
  totalDue: number              // principal + commission
  outstanding: number           // baja con cada repago
  currency: string
  fundingSource: 'dropi'
  disbursementTarget: 'dropi_wallet'
  dropiWalletRef: string | null // tx EP1
  collectionMode: 'auto_netting' | 'manual_pull'
  nettingRate: number           // 0.50 (D4)
  repaymentSchedule: jsonb      // { type: 'continuous_netting', rate }
  approvedBy: string | null
  approvedAt: timestamptz | null
  disbursedAt: timestamptz | null
  settledAt: timestamptz | null
  termsSnapshot: jsonb
}
```

### 5.3 `loan_repayment` — cada neteo aplicado
```ts
@Entity('loan_repayment')
@Index(['settlementRef'], { unique: true })   // idempotencia del ingest
class LoanRepayment {
  loanId: string
  brandId: string
  amount: number
  source: 'dropi_settlement_netting' | 'manual_pull' | 'manual_adjustment'
  settlementRef: string
  appliedAt: timestamptz
  outstandingAfter: number
}
```

### 5.4 `dropi_settlement_event` — ingest crudo (conciliación)
```ts
@Entity('dropi_settlement_event')
@Index(['externalId'], { unique: true })
class DropiSettlementEvent {
  externalId: string
  brandId: string
  loanRef: string | null
  grossSettlement: number
  withheldForLoan: number
  netToMerchant: number
  currency: string
  occurredAt: timestamptz
  raw: jsonb
  reconciled: boolean
}
```

### 5.5 `outbox_event` — outbox transaccional (reusable en payments)
```ts
@Entity('outbox_event')
@Index(['status', 'createdAt'])
class OutboxEvent {
  topic: string                 // 'loan.disbursed', etc.
  payload: jsonb
  status: 'pending' | 'published' | 'failed'
  attempts: number
  publishedAt: timestamptz | null
}
```

### 5.6 Migración
- `migrations/<Date.now()>-AddCreditLoanLoop.ts` — crea las 6 tablas + índices únicos. **Timestamp real de 13 dígitos.**

---

## 6. Config y perillas (§6.1 del contrato)

`src/credit/loan/credit-loan-config.ts` (v1: defaults + override por env; fast-follow: tabla versionada estilo `scoreScaleConfig`).

| Perilla | v1 | Uso |
|---|---|---|
| `HAIRCUT` | 0.70 | `carteraCap = HAIRCUT × carteraBalance` |
| `MIN_CARTERA` | 500_000 | gate de elegibilidad |
| `MIN_VELOCITY` | 300_000 | gate (avgWeeklySettlement) |
| `MIN_CUPO` | 300_000 | si cupo < esto → no ofrecer |
| `NETTING_RATE` | 0.50 | retención por liquidación |
| `DEFAULT_AFTER_DAYS` | (definir) | sin neteo N días → `defaulted` |

Fórmula: `cupo = min(tier.disbursement, HAIRCUT × carteraBalance)`. Solo cartera existente; `pendingDelivery` y velocidad NO inflan (velocidad es solo gate).

---

## 7. Cliente Dropi + mock (Fase 2)

`src/credit/client/dropi-funding.client.ts` — espejo de `credit-inputs.client.ts`.

```ts
class DropiFundingClient {
  creditWallet(p: { idempotencyKey, brandId, amount, currency, loanRef, concept, metadata? })
    : Promise<{ status, dropiWalletTxRef, walletBalanceAfter, occurredAt }>          // EP1
  collectFromCartera(p: { idempotencyKey, brandId, loanRef, amount, currency })
    : Promise<{ status, collectedAmount, shortfall, carteraBalanceAfter, settlementRef, occurredAt }> // EP2
  getCarteraBalance(brandId: string)
    : Promise<{ carteraBalance, pendingDelivery, avgWeeklySettlement, currency, asOf }> // EP4
}
```
- `fetch` nativo, `Authorization: Bearer ${DROPI_FUNDING_TOKEN}`, `Idempotency-Key` header, timeouts 30/30/10s, backoff ×3 en 5xx, mapeo del envelope de error del contrato.
- **`DropiFundingClientMock`** (provider intercambiable por env `CREDIT_DROPI_MOCK=true`) → desbloquea Fases 3-7 sin Dropi.

---

## 8. Underwriting de cupo (Fase 3)

`src/credit/loan/loan-underwriting.service.ts`:
```ts
computeOffer(brandId): Promise<{
  status: 'eligible' | 'near' | 'no_data' | 'not_eligible',
  cupo: number | null, tier, reasonsMissing?: string[]   // p/ la UI gradiente
}>
```
- Toma el `credit_score` fresco + EP4 (`getCarteraBalance`).
- Aplica gates (§6) y fórmula de cupo. `near` = elegible por score pero falla gate de cartera/velocidad → devuelve qué falta (alimenta "te faltan X ventas").
- **Endpoint:** `GET /credit/offer/:brandId` (brand-scope, igual que `preapproval`).

---

## 9. Saga de desembolso (Fase 4) — el corazón

`src/credit/loan/loan.service.ts` + `src/credit/loan/loan.controller.ts` + outbox worker.

### Máquina de estados
```
offered ─request→ pending_approval ─approve→ approved ─EP1 ok→ active ─neteo→ repaying ─outstanding=0→ settled
                       │ reject              │ EP1 falla → cancelled            │ N días sin neteo → defaulted → written_off
                       └→ cancelled
```

### Endpoints + flujo
```
POST /credit/loans/request {brandId}                      [botón merchant]
  1. computeOffer fresco + re-aplica veto ROAS
  2. si no eligible → 200 {status:'not_eligible'|'near', ...}  (NO crea loan)
  3. valida: consent habeas data OK + sin loan activo + cupo ≥ MIN_CUPO
  4. BEGIN TX: crea loan(pending_approval) + outbox 'loan.requested'  COMMIT
  → 202 {loanId, status:'pending_approval'}

POST /credit/loans/:id/approve  | /reject                 [admin, RBAC credit:approve]
  approve:
    1. loan → approved
    2. EP1 creditWallet({idempotencyKey: loanId, ...})    [fuera de TX, idempotente]
    3a. éxito → BEGIN TX: loan→active, dropiWalletRef, disbursedAt, outbox 'loan.disbursed' COMMIT
    3b. falla/timeout → loan→cancelled + outbox 'loan.cancelled'  (compensación: nada se acreditó)
  reject:
    loan → cancelled + motivo
```
- Idempotencia: reintentar paso 2 con el mismo `loanId` no duplica caja (Dropi devuelve el resultado original).
- Lock en `loan` para transiciones de estado.

### Outbox worker
`src/event-bus/outbox.worker.ts` (cron corto o BullMQ): toma `outbox_event` pending → publica a Redis Streams → marca `published`. Reintentos con backoff.

---

## 10. Ingest de neteo + cobro manual + conciliación (Fase 5)

`src/credit/loan/repayment.service.ts` + `settlement.controller.ts`.

```
POST /credit/settlements/netting-report           [EP3, ServerTokenGuard + timingSafeEqual]
  por evento (idempotente por externalId):
    BEGIN TX
      insert dropi_settlement_event
      si withheldForLoan > 0:
        insert loan_repayment(amount=withheld, settlementRef=externalId)  [único]
        loan.outstanding -= withheld        [lock pesimista en loan]
        si outstanding<=0 → loan.settled + settledAt + credit_line.active + outbox 'loan.settled'
        else → loan.repaying + outbox 'repayment.applied'
    COMMIT
  → 200 { received, applied, duplicates, rejected:[{externalId, reason}] }

POST /credit/loans/:id/collect {amount}            [admin, botón manual = modo EP2]
  1. EP2 collectFromCartera({idempotencyKey: repaymentId, ...})
  2. registra loan_repayment(source:'manual_pull', settlementRef=resp.settlementRef, amount=collectedAmount)
     (registra collectedAmount real, no el pedido)
```

### Conciliación
`src/credit/loan/reconciliation.task.ts` (cron nocturno, `@nestjs/schedule`):
- `Σ withheldForLoan` (settlement_events) vs `Σ loan_repayment` → descuadre → alerta admin (no autocorrige).
- `loan` en `active`/`repaying` sin neteo en `DEFAULT_AFTER_DAYS` → `defaulted` + outbox `loan.defaulted`.

---

## 11. Eventos (Fase 6)

Outbox → Redis Streams. Topics: `loan.requested`, `loan.disbursed`, `loan.cancelled`, `repayment.applied`, `loan.settled`, `loan.defaulted`.
Consumidores existentes: **realtime** (estado en vivo), **notificaciones** (push/WhatsApp "te llegó tu desembolso"), **ai** (narrativa).

---

## 12. APIs (resumen — payloads detallados en el contrato)

| Método | Endpoint | Auth | Fase |
|---|---|---|---|
| GET | `/credit/offer/:brandId` | sesión (brand-scope) | 3 |
| POST | `/credit/loans/request` | sesión (brand-scope) | 4 |
| GET | `/credit/loans/brand/:brandId` | sesión (brand-scope) | 4 |
| POST | `/credit/loans/:id/approve` `/reject` | RBAC `credit:approve` | 4 |
| POST | `/credit/loans/:id/collect` | RBAC `credit:approve` | 5 |
| GET | `/credit/loans?status=` | RBAC `credit:runs` | 4 |
| GET | `/credit/reconciliation` | RBAC `credit:runs` | 5 |
| POST | `/credit/settlements/netting-report` | ServerToken (Dropi) | 5 |

---

## 13. UIs (Fase 7)

- **Admin (`admin/`):** cola `pending_approval` con score/cupo/cartera → approve/reject; lista de préstamos activos + `outstanding`; dashboard de conciliación; botón "Cobrar de cartera". Es donde el admin contacta a las 10.
- **Cliente (dentro de Dropi, `dropi-front-wallet` sección roax):** oferta gradiente (narrativa 5-pasos terminando en "Estás pre-aprobado para $X → Pedir desembolso") + vista de préstamo activo.

---

## 14. Testing (Fase 8)

- Unit: `loan-underwriting` (fórmula §6.1, gates, ejemplos A/B/C del contrato), score-engine ya cubierto.
- Saga: happy-path; EP1 falla → cancelled; replay de approve no duplica.
- Ingest: idempotencia por externalId; cobro parcial; settle exacto; default por inactividad.
- Seguridad: `timingSafeEqual` del server-token.
- e2e con `DropiFundingClientMock`. **Meter e2e en el script `verify`** (hoy payments no lo corre — bug D1).

---

## 15. Plan por fases (checklist)

### Fase 0 — Prerrequisitos
- [ ] Confirmar contrato congelado con Dropi (las 5 preguntas operativas §7).
- [ ] [MANUAL/usuario] Firma legal de D1 (factoring/usura).
- [ ] [MANUAL/usuario] P0 seguridad del vault (bloquea go-live, no dev).
- [ ] Definir `DEFAULT_AFTER_DAYS` y el `factor`/perillas finales.

### Fase 1 — Modelo de datos `[S/M]`
- [ ] 6 entidades (§5).
- [ ] Migración `<timestamp-real>-AddCreditLoanLoop.ts` con índices únicos.

### Fase 2 — Cliente Dropi + mock `[M]`
- [ ] `DropiFundingClient` (EP1/EP2/EP4) + manejo de errores/idempotencia.
- [ ] `DropiFundingClientMock` conmutable por env.

### Fase 3 — Underwriting de cupo `[M]`
- [ ] `CreditLoanConfig` (perillas).
- [ ] `loan-underwriting.service` (`computeOffer`).
- [ ] `GET /credit/offer/:brandId`.

### Fase 4 — Saga de desembolso `[L]`
- [ ] `outbox_event` + `outbox.worker`.
- [ ] `POST /credit/loans/request` (re-score + gates + crea loan).
- [ ] `approve`/`reject` con EP1 + compensación.
- [ ] Máquina de estados + locks.
- [ ] `GET /credit/loans/brand/:brandId`, `GET /credit/loans`.

### Fase 5 — Ingest + cobro + conciliación `[L]`
- [ ] `POST /credit/settlements/netting-report` (ServerToken + timingSafeEqual, idempotente).
- [ ] `POST /credit/loans/:id/collect` (EP2).
- [ ] `reconciliation.task` (descuadre + defaults).
- [ ] `GET /credit/reconciliation`.

### Fase 6 — Eventos `[S/M]`
- [ ] Worker outbox publica los 6 topics.
- [ ] Verificar consumo en realtime/notificaciones/ai.

### Fase 7 — UIs `[M/L]`
- [ ] Admin: cola + approve + activos + conciliación + cobrar.
- [ ] Cliente Dropi: oferta gradiente + préstamo activo.

### Fase 8 — Integración + go-live `[M]`
- [ ] Mock → cliente real; pruebas de contrato.
- [ ] Suite de tests + e2e en `verify`.
- [ ] Correr scoring sobre las 10 → admin aprueba → ciclo autofinanciado → medir.

---

## 16. Camino crítico

```
F1 ─┬─► F3 ─┐
    ├─► F2 ─┼─► F4 ─► F5 ─► F6 ─► F8 (go-live)
    │       └──────────────► F7 (UI, paralelo)
 Dropi construye su mitad (paralelo) ──────────► F8
```
Crítico: **F1 → F4 → F5 → F8**. F4 y F5 son el grueso. Paralelo: Dropi, F7, P0 seguridad.

## 17. Variante "piloto mínimo" (si se quiere validar la toma antes)

F1 + F3 + F4 **sin saga automática** (desembolso disparado a mano por admin tras EP1) + cobro **solo** por botón EP2. Deja auto-netting (EP3), conciliación robusta y notificaciones para después de validar que el merchant toma y repaga. Llega a las 10 mucho antes.

---

## 18. Anexo — archivos a crear/tocar

```
backend-payments/src/credit/
  entities/
    creditLine.entity.ts            [nuevo]
    loan.entity.ts                  [nuevo]
    loanRepayment.entity.ts         [nuevo]
    dropiSettlementEvent.entity.ts  [nuevo]
  loan/
    credit-loan-config.ts           [nuevo]  perillas §6
    loan-underwriting.service.ts    [nuevo]  cupo §6.1
    loan.service.ts                 [nuevo]  saga
    loan.controller.ts              [nuevo]  request/approve/reject/collect/list
    repayment.service.ts            [nuevo]  ingest neteo
    settlement.controller.ts        [nuevo]  EP3 inbound
    reconciliation.task.ts          [nuevo]  cron
    guard/server-token.guard.ts     [nuevo]  timingSafeEqual (o reusar patrón processes)
  client/
    dropi-funding.client.ts         [nuevo]  EP1/EP2/EP4
    dropi-funding.client.mock.ts    [nuevo]
  credit.module.ts                  [editar] registrar providers/controllers
src/event-bus/
  entities/outboxEvent.entity.ts    [nuevo]
  outbox.worker.ts                  [nuevo]
migrations/
  <Date.now()>-AddCreditLoanLoop.ts [nuevo]
```
```
admin/  → pantallas de cola/aprobación/conciliación
dropi-front-wallet/src/app/.../roax  → oferta gradiente + préstamo activo
```
```
backend-roles  → permisos credit:approve (si no existen) en el catálogo
```

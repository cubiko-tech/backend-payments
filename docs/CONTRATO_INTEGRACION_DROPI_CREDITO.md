# Contrato de integración Roax ↔ Dropi — Crédito / Anticipo de pauta

> Estado: **borrador para acordar con el equipo de Dropi.** Define los 4 endpoints
> que conectan el motor de crédito de Roax (`backend-payments/src/credit`) con el
> Dropi Wallet y la cartera COD de Dropi.
>
> Modelo de negocio (resumen): la plata **siempre se mueve Dropi→Dropi**. Dropi
> acredita el **Dropi Wallet** del merchant (desembolso) y recupera desde la
> **cartera COD** del mismo merchant (repago). Roax es el cerebro: decide a quién
> y cuánto (scoring), aprueba en su admin, y lleva el **libro contable** del
> préstamo. Roax **nunca custodia caja**.
>
> Documentos relacionados: `DISEÑO_SCORING_CREDITO.md` (scoring/pre-aprobado),
> `PLAN_PAYMENTS_COMPLETO.md`.

---

## 0. Quién hace qué

| Actor | Responsabilidad |
|---|---|
| **Roax** | Scoring + pre-aprobado, aprobación manual (admin), libro del préstamo (`loan`, `loan_repayment`), conciliación, eventos. Origina el desembolso y registra los repagos. |
| **Dropi** | Caja. Acredita el Dropi Wallet del merchant, retiene/cobra de la cartera COD, reporta los neteos. Es el prestamista de récord (anticipo sobre cartera propia). |

**Estructura acordada (ver "Decisiones tomadas"):** Dropi adelanta, sobre su
propia cartera COD, un monto **dimensionado a la cartera existente**, etiquetado
como **anticipo de pauta**, y se cobra neteando de esa misma cartera. **Dropi es
el prestamista de récord (factoring/anticipo sobre cartera); Roax origina,
underwritea y aprueba**, y cobra un fee sobre la comisión. La plata nunca sale del
ecosistema Dropi ni del balance de Roax.

Flujo macro:

```
Merchant pide → Roax re-score + veto ROAS → loan(pending_approval)
            → Admin Roax APRUEBA
            → [EP1] Roax ordena a Dropi acreditar el Dropi Wallet  ──► desembolso
            → loan(active, outstanding = principal + comisión)
Repago (continuo):
   Modo auto  → [EP3] Dropi reporta neteos desde cartera        ──► Roax baja outstanding
   Modo botón → [EP2] Admin Roax fuerza cobro desde cartera      ──► Roax baja outstanding
   outstanding = 0 → loan(settled) → la línea queda libre para re-pedir
Underwriting de capacidad:
   [EP4] Roax consulta el balance de cartera antes de aprobar
```

---

## Decisiones tomadas (postura cerrada del lado Roax — no son preguntas a Dropi)

Estas dos definiciones son del lado de Roax + legal y ya están tomadas. Se
documentan acá para que la integración parta de una postura, no de un debate.

### D1. Prestamista de récord: **Dropi**, estructurado como anticipo sobre cartera (factoring)
- Lo que ocurre es un **anticipo sobre cartera propia**: Dropi adelanta plata que
  recupera de plata que ya le debe al mismo merchant. Se caracteriza como
  factoring/anticipo, **no como crédito** — perfil regulatorio más liviano en
  Colombia (evita licencia de entidad financiera; cuidar el tope de **usura**).
- **Roax no presta de su balance.** Roax origina, underwritea y aprueba; cobra un
  **fee sobre la comisión** (el 2-3.5% de la escala) como originación + tech.
  El interés/spread es de Dropi. Roax sigue siendo empresa de data/tech, no fintech-lender.
- El riesgo va con quien tiene el colateral (la cartera) = Dropi.
- ⚠️ **Requiere firma de legal financiero (Colombia):** instrumento exacto
  (factoring / compra de cartera / anticipo) y que **la comisión sea descuento/fee,
  no interés**, dentro del tope de usura. La dirección está cerrada; la letra fina la valida legal.

### D2. Dropi Wallet: **líquido pero etiquetado "anticipo de pauta"**; el control real es el sizing contra cartera, NO el fencing del wallet
- El desembolso se **etiqueta como anticipo de pauta** (campo `concept` de EP1 +
  copy del producto): importa para la caracterización legal y para la narrativa,
  aunque la restricción técnica sea blanda.
- **En el piloto el wallet es funcionalmente líquido.** No se bloquea el piloto
  esperando un wallet "fenceado solo-pauta": el gasto en Meta ocurre fuera de Dropi,
  así que cualquier cerca tiene fugas y no aporta seguridad real.
- **El control que carga el peso es el sizing contra cartera existente (EP4):**
  prestar un monto cubierto en su mayoría por la cartera que Dropi **ya tiene** del
  merchant al desembolsar — no por la proyectada. Así, aunque el merchant agarre la
  plata y deje de vender, lo desembolsado es recuperable de receivables ya retenidos.
- El riesgo real es "deja de vender", y contra eso el spend-fence no hace nada; el
  sizing sí. **Restricción dura de uso = Fase 2, solo si los datos la justifican.**

---

## 1. Convenciones comunes (aplican a los 4 endpoints)

### 1.1 Transporte
- HTTPS obligatorio, siempre vía gateway. `Content-Type: application/json; charset=utf-8`.
- Base URLs (a definir por ambiente):
  - Dropi expone EP1, EP2, EP4 bajo `DROPI_FUNDING_BASE` (ej. `https://api.dropi.../v1/funding`).
  - Roax expone EP3 bajo `ROAX_PAYMENTS_BASE` (ej. `https://app.roaxai.com/payments/v1/credit`).

### 1.2 Autenticación (server-to-server, bidireccional)
- **Roax → Dropi (EP1, EP2, EP4):** `Authorization: Bearer <token que emite Dropi para Roax>`.
- **Dropi → Roax (EP3):** `Authorization: Bearer <token que emite Roax para Dropi>`
  (mismo patrón que el guard `ServerTokenGuard` ya usado en `credit-inputs`).
- **Requisito de seguridad (ambos lados):** comparar el token con **comparación de
  tiempo constante** (`crypto.timingSafeEqual` con longitudes igualadas), no `===`.
  Usar un **token dedicado por integración** (no el `ACCESS_SERVER` compartido) para
  acotar el blast radius. El esquema `Bearer` debe matchear case-insensitive pero
  emitirse siempre en minúscula `bearer` no — emitir `Bearer` canónico.

### 1.3 Dinero
- Montos como **string decimal** con 2 decimales (`"150000.00"`), nunca float.
  Coherente con `decimal(15,2)` del ledger de payments.
- `currency`: ISO 4217 (`"COP"`). El piloto es solo COP; el campo es obligatorio
  igual para no romper cuando se sumen mercados.

### 1.4 Tiempos
- Todo timestamp en **ISO 8601 UTC** con `Z` (`"2026-06-25T14:03:00Z"`).

### 1.5 Idempotencia (crítico — es plata)
- Toda operación que **mueve dinero** (EP1, EP2) lleva `idempotencyKey` en el body
  **y** header `Idempotency-Key` con el mismo valor.
- Regla del receptor:
  - Misma key + **mismo** payload → devolver el **resultado original** (200), sin
    re-ejecutar. No duplicar el movimiento.
  - Misma key + payload **distinto** → `409 idempotency_conflict`.
- EP3 (reporte de neteos) es idempotente por `externalId` de cada evento: un
  `externalId` repetido se ACK como duplicado (200), no es error.

### 1.6 Envelope de error (todos los endpoints)
```json
{
  "error": {
    "code": "string_maquina",
    "message": "texto humano",
    "details": { "campo": "motivo" }
  }
}
```
Códigos HTTP: `400` payload inválido · `401` auth · `404` recurso no existe ·
`409` conflicto de idempotencia · `422` regla de negocio (ej. wallet congelado,
cartera insuficiente) · `429` rate limit · `503` reintentar.

### 1.7 Reintentos
- El emisor reintenta `5xx`/timeout con backoff exponencial (3 intentos), apoyado
  en idempotencia. No reintentar `4xx` (salvo `429`).
- Timeouts sugeridos: EP1/EP2 = 30 s; EP3 = 30 s (batch); EP4 = 10 s.

---

## 2. EP1 — Acreditar Dropi Wallet (desembolso)

**Dirección:** Roax → Dropi · **Mueve plata:** sí (Dropi → Dropi Wallet del merchant).
Se invoca **solo** después de la aprobación manual en el admin de Roax.

```
POST {DROPI_FUNDING_BASE}/wallet/credit
Authorization: Bearer <token-dropi-para-roax>
Idempotency-Key: <loanId>
```

### Request
```json
{
  "idempotencyKey": "9f2c-...-loanId",
  "brandId": "brand_abc123",
  "amount": "1500000.00",
  "currency": "COP",
  "loanRef": "9f2c-...-loanId",
  "concept": "Anticipo de pauta Roax",
  "metadata": { "tier": "builder", "scoreId": "..." }
}
```

| Campo | Tipo | Req | Descripción |
|---|---|---|---|
| `idempotencyKey` | string | ✓ | = `loanId`. Garantiza no duplicar el desembolso. |
| `brandId` | string | ✓ | ID de marca (mismo que usa `credit-inputs`). |
| `amount` | string decimal | ✓ | Monto a acreditar (principal). |
| `currency` | string | ✓ | `"COP"`. |
| `loanRef` | string | ✓ | ID del préstamo en Roax (para el reporte de neteos EP3). |
| `concept` | string | ✓ | Glosa visible en el movimiento del Dropi Wallet. |
| `metadata` | object | ✗ | Libre, para trazabilidad. |

### Response 200
```json
{
  "status": "credited",
  "dropiWalletTxRef": "dwtx_55812",
  "brandId": "brand_abc123",
  "amount": "1500000.00",
  "currency": "COP",
  "walletBalanceAfter": "1850000.00",
  "occurredAt": "2026-06-25T14:03:00Z"
}
```

| Campo | Descripción |
|---|---|
| `status` | `"credited"`. |
| `dropiWalletTxRef` | ID del movimiento en Dropi (Roax lo guarda en `loan.dropiWalletRef`). |
| `walletBalanceAfter` | Saldo del Dropi Wallet tras la acreditación. |

### Errores específicos
- `404 brand_not_found` / `404 wallet_not_found`
- `422 wallet_frozen` · `422 brand_suspended`
- `409 idempotency_conflict`

> **Decidido (ver D2):** el Dropi Wallet es **líquido** en el piloto, con el
> desembolso **etiquetado "anticipo de pauta"** vía `concept`. El control de riesgo
> NO es el fencing del wallet sino el **sizing contra cartera existente (§6.1, EP4)**.
> Restricción dura de uso queda para Fase 2 si los datos la justifican.

---

## 3. EP2 — Cobrar desde cartera (pull manual / modo botón)

**Dirección:** Roax → Dropi · **Mueve plata:** sí (cartera COD → repago del préstamo).
Disparado por el botón "Cobrar de cartera" en el admin de Roax. El modo principal
es el auto-netting (EP3); este es el respaldo/forzado.

```
POST {DROPI_FUNDING_BASE}/cartera/collect
Authorization: Bearer <token-dropi-para-roax>
Idempotency-Key: <repaymentId>
```

### Request
```json
{
  "idempotencyKey": "rp_7781-...",
  "brandId": "brand_abc123",
  "loanRef": "9f2c-...-loanId",
  "amount": "300000.00",
  "currency": "COP"
}
```

| Campo | Tipo | Req | Descripción |
|---|---|---|---|
| `idempotencyKey` | string | ✓ | = `repaymentId` que genera Roax. |
| `brandId` | string | ✓ | Marca. |
| `loanRef` | string | ✓ | Préstamo a abonar. |
| `amount` | string decimal | ✓ | Monto a cobrar (≤ `outstanding`). |
| `currency` | string | ✓ | `"COP"`. |

### Response 200
```json
{
  "status": "collected",
  "collectedAmount": "300000.00",
  "shortfall": "0.00",
  "carteraBalanceAfter": "120000.00",
  "settlementRef": "dcol_99210",
  "occurredAt": "2026-06-25T15:10:00Z"
}
```

| Campo | Descripción |
|---|---|
| `status` | `"collected"` (total) · `"partial"` (cartera < `amount`) · `"insufficient_cartera"` (0 cobrado). |
| `collectedAmount` | Lo efectivamente debitado de la cartera. Roax registra **esto**, no el `amount` pedido. |
| `shortfall` | `amount − collectedAmount`. |
| `settlementRef` | ID del cobro en Dropi → entra como `settlementRef` único en `loan_repayment`. |

### Errores específicos
- `422 insufficient_cartera` (cuando se prefiere error a cobro parcial; acordar cuál)
- `404 loan_not_found` · `409 idempotency_conflict`

---

## 4. EP3 — Reporte de neteos automáticos (modo principal)

**Dirección:** Dropi → Roax · **Mueve plata:** no (informa neteos ya hechos por
Dropi al liquidar COD). Roax aplica cada evento a `loan.outstanding`.

```
POST {ROAX_PAYMENTS_BASE}/settlements/netting-report
Authorization: Bearer <token-roax-para-dropi>
```

### Request (batch)
```json
{
  "events": [
    {
      "externalId": "dset_44120",
      "brandId": "brand_abc123",
      "loanRef": "9f2c-...-loanId",
      "grossSettlement": "500000.00",
      "withheldForLoan": "150000.00",
      "netToMerchant": "350000.00",
      "currency": "COP",
      "occurredAt": "2026-06-25T06:00:00Z"
    }
  ]
}
```

| Campo | Tipo | Req | Descripción |
|---|---|---|---|
| `externalId` | string | ✓ | ID único del evento de liquidación en Dropi. **Clave de idempotencia.** |
| `brandId` | string | ✓ | Marca. |
| `loanRef` | string | ✓ | Préstamo neteado. |
| `grossSettlement` | string decimal | ✓ | Lo que Dropi iba a pagarle al merchant. |
| `withheldForLoan` | string decimal | ✓ | Lo retenido para el préstamo (= repago). |
| `netToMerchant` | string decimal | ✓ | `gross − withheld`. |
| `occurredAt` | string ISO | ✓ | Cuándo ocurrió el neteo. |

### Response 200
```json
{
  "received": 10,
  "applied": 9,
  "duplicates": 1,
  "rejected": [
    { "externalId": "dset_44131", "reason": "loan_not_found" }
  ]
}
```

- `duplicates`: `externalId` ya procesados (idempotente, no error).
- `rejected`: eventos no aplicables (Dropi debe reintentarlos corregidos o
  escalarlos). Motivos: `loan_not_found`, `loan_already_settled`, `amount_invalid`.

> El envío puede ser **batch periódico** (ej. tras cada corrida de liquidación) o
> **por evento**. Acordar cadencia. Roax concilia de noche `Σ withheldForLoan`
> contra `Σ loan_repayment`.

---

## 5. EP4 — Balance de cartera (underwriting de capacidad)

**Dirección:** Roax → Dropi · **Mueve plata:** no. Roax lo consulta **antes de
aprobar** para dimensionar el desembolso contra la cartera real, no solo el score.

```
GET {DROPI_FUNDING_BASE}/cartera/balance?brandId=brand_abc123
Authorization: Bearer <token-dropi-para-roax>
```

### Response 200
```json
{
  "brandId": "brand_abc123",
  "carteraBalance": "2400000.00",
  "pendingDelivery": "900000.00",
  "avgWeeklySettlement": "1800000.00",
  "currency": "COP",
  "asOf": "2026-06-25T14:00:00Z"
}
```

| Campo | Descripción |
|---|---|
| `carteraBalance` | Cartera viva: COD entregado pendiente de liquidar al merchant. |
| `pendingDelivery` | COD en tránsito (aún no entregado). |
| `avgWeeklySettlement` | Velocidad de liquidación de las últimas N semanas (capacidad de repago). |

Errores: `404 brand_not_found`.

---

## 6. Riesgo y controles

1. **Sizing contra cartera existente — REQUISITO DURO DE APROBACIÓN (no es un
   "control" opcional).** El admin **no puede aprobar** un monto por encima de
   `carteraBalance × factor` (EP4), donde el grueso del desembolso queda cubierto
   por la cartera que Dropi **ya retiene** del merchant. La cartera proyectada
   (`avgWeeklySettlement`) solo puede complementar, nunca sustituir, a la existente.
   Este es el control que carga el peso del riesgo (ver D2).
2. **Exposición acotada.** 1 préstamo activo por marca; montos por tier ($1–2M).
3. **Default.** Sin neteo en N días → Roax marca `defaulted`; política de
   write-off a definir. Como es anticipo sobre cartera propia de Dropi (D1), la
   pérdida máxima ≈ lo desembolsado por encima de la cartera recuperable — que el
   sizing del punto 1 mantiene cerca de cero.
4. **Uso del wallet.** Líquido + etiquetado (D2). No se usa como control de riesgo;
   el sizing del punto 1 lo cubre. Restricción dura = Fase 2 si los datos la piden.

### 6.1 Fórmula de cupo y perillas (valores iniciales del piloto)

Conservadores a propósito: en un piloto con plata real conviene pecar de chico y
soltar después. Todos son perillas calibrables con las 10 marcas.

```
cupo = min( tier.disbursement , carteraCap )

carteraCap = HAIRCUT × carteraBalance      // solo cartera YA retenida por Dropi (EP4)
```

`carteraBalance` (EP4) = lo que Dropi ya le debe al merchant (COD entregado,
pendiente de liquidar). En v1 **no** entra `pendingDelivery` (COD en tránsito,
riesgo de entrega) ni se infla con velocidad: la velocidad es solo gate de
elegibilidad, nunca agranda el cupo. Esto materializa el requisito duro de §6
(punto 1): la cartera existente carga el peso, la proyectada nunca sustituye.

**Gates de elegibilidad por cartera** (además de tier≠no_eligible, sin veto ROAS,
consent habeas data, sin loan activo):

| Gate | Valor v1 | Por qué |
|---|---|---|
| `carteraBalance ≥ MIN_CARTERA` | $500.000 COP | Piso de colateral. |
| `avgWeeklySettlement ≥ MIN_VELOCITY` | $300.000 COP/sem | Prueba de venta sostenida (control real contra "agarra la plata y deja de vender"). |

**Perillas:**

| Perilla | Valor v1 | Racional |
|---|---|---|
| `HAIRCUT` (el "factor") | **0,70** | Anticipa hasta 70% de la cartera retenida; el 30% absorbe devoluciones/disputas COD post-entrega, la comisión (2-3,5%) y el neto que el merchant igual necesita cobrar. |
| `MIN_CARTERA` | $500.000 | Gate de colateral. |
| `MIN_VELOCITY` | $300.000/sem | Gate de venta sostenida. |
| `MIN_CUPO` | $300.000 | Si el cupo resultante es menor, no se ofrece. |
| `NETTING_RATE` (tasa de neteo) | 50% de cada liquidación | Cuánto retiene Dropi por liquidación hasta saldar; deja 50% al merchant para operar; salda en ~2 ciclos. |

**Ejemplos:**

| Marca | Tier (cupo máx) | carteraBalance | carteraCap (×0,70) | Cupo final | Manda |
|---|---|---|---|---|---|
| A | Builder ($1,5M) | $2.400.000 | $1.680.000 | $1.500.000 | tier |
| B | Builder ($1,5M) | $1.200.000 | $840.000 | $840.000 | cartera (el sizing protege) |
| C | Starter ($1M) | $400.000 | — | no se ofrece | falla `MIN_CARTERA` |

**Calibración con el piloto:** 0 defaults en 2-3 ciclos → subir `HAIRCUT` a 0,80 y
empezar a sumar `pendingDelivery × factor_bajo`. Si aparece mora → bajar `HAIRCUT`
o subir los gates antes de tocar otra cosa. `NETTING_RATE` se ajusta según queja de
cash-flow de los merchants vs velocidad de repago deseada.

---

## 7. Preguntas operativas para el equipo de Dropi

> El prestamista de récord (D1) y el uso del wallet (D2) ya están decididos del
> lado de Roax. Lo que queda para Dropi es operativo:

1. ¿El **auto-netting** desde cartera (EP3) lo puede hacer Dropi hoy, o arrancamos
   el piloto solo con el **botón manual** (EP2)?
2. **Cadencia de EP3:** ¿batch tras cada liquidación o por evento?
3. En EP2, ¿se prefiere **cobro parcial** (`partial`) o **error** cuando la cartera
   no alcanza?
4. Emisión y rotación de los **tokens server-to-server** dedicados (uno por sentido).
5. Confirmar que **EP4** (balance de cartera viva) es consultable en tiempo real —
   es el insumo del requisito duro de sizing (§6.1).

---

## 8. Glosario

| Término | Significado |
|---|---|
| **Dropi Wallet** | Billetera del merchant dentro de Dropi. Destino del desembolso. |
| **Cartera COD** | Plata que Dropi le debe al merchant por pedidos contra-entrega ya entregados. Fuente del repago. |
| **Neteo** | Retención que Dropi aplica sobre la liquidación COD para abonar el préstamo. |
| **`loan` / `loanRef`** | Préstamo vivo en Roax (system-of-record de la deuda). |
| **Anticipo sobre cartera** | Estructura legal: Dropi adelanta plata que recuperará de la cartera propia del mismo merchant. |

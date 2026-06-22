# Scoring de crédito — Guía para el frontend

Cómo funciona el score de crédito de una marca y cómo consumir la API de
`backend-payments` para mostrarlo y graficarlo.

> **Fuente de verdad del modelo:** `docs/DISEÑO_SCORING_CREDITO.md`.
> **Implementación:** `src/credit/`. Esta guía está derivada del código real
> (motor `domain/score-engine.ts`, escala `domain/scale-config.v1.ts`,
> snapshot `entities/creditScore.entity.ts`, endpoints `credit.controller.ts`).

---

## 1. Concepto

- **El sujeto del score es la MARCA (`brandId`), no el usuario.** Un usuario ve
  el score de la(s) marca(s) a las que pertenece.
- El score es un **snapshot inmutable**: cada cálculo crea una fila nueva en
  `credit_score`. Nunca se sobreescribe → hay **historial completo** por marca,
  ideal para graficar evolución en el tiempo.
- Un score se calcula para un **período** (meses completos). Puede dispararse
  de a una marca (`scores/calculate`) o masivamente para todas las marcas
  puntuables (`runs`).
- La **moneda base** del modelo es COP. Los insumos en otra moneda se convierten
  con la tasa (fx) del período, que queda guardada en el snapshot.

---

## 2. El modelo de score

El total es un número entero **0–100** = suma ponderada de tres subscores
(cada uno también 0–100):

| Subscore     | Peso | Qué mide                                          |
| ------------ | ---- | ------------------------------------------------- |
| `investment` | 40 % | Inversión Meta mensual promedio (en moneda base)  |
| `roas`       | 40 % | ROAS del período = ventas entregadas ÷ spend Meta |
| `sales`      | 20 % | Ventas entregadas (COD) mensuales promedio        |

```
total = round(investment*0.40 + roas*0.40 + sales*0.20)
```

> **ROAS = ventas ENTREGADAS Dropi ÷ spend Meta** (ROAS real cobrado por COD),
> no el `purchase_value` autoreportado por Meta. `roasValue` (el ratio crudo) y
> los tres subscores vienen en el snapshot, así que se pueden graficar.

### Escala v1 (tramos por cota superior exclusiva)

Cada insumo se mapea a un subscore por tramos. Versión `scaleVersion: 1`:

- **Inversión mensual (COP):** `<2M→10 · <4M→30 · <6M→50 · <10M→70 · <18M→85 · ≥18M→100`
- **ROAS (ratio):** `<1.5→0 · <2.0→15 · <2.5→30 · <3.0→50 · <3.5→65 · <4.5→80 · <6.0→92 · ≥6.0→100`
- **Ventas mensuales (COP):** `<5M→10 · <10M→30 · <20M→50 · <40M→70 · <70M→88 · ≥70M→100`

> La escala es **versionada y editable** desde el admin. Para graficar correctamente
> los umbrales, leelos en runtime de `GET /config/scales` en vez de hardcodearlos.

### Niveles (tiers)

El `total` cae en un nivel, que define monto de desembolso, cupo semanal
(= 3× desembolso) y comisión:

| Nivel (`tier.key`) | Nombre        | Rango total | Desembolso (COP) | Comisión |
| ------------------ | ------------- | ----------- | ---------------- | -------- |
| `no_eligible`      | No elegible   | 0–39        | 0                | —        |
| `starter`          | Starter Ads   | 40–54       | 1.000.000        | 3,5 %    |
| `builder`          | Builder       | 55–64       | 1.500.000        | 3,0 %    |
| `growth_seller`    | Growth Seller | 65–74       | 2.000.000        | 2,5 %    |
| `pro_marketer`     | Pro Marketer  | 75–84       | 2.000.000        | 2,25 %   |
| `elite`            | Elite         | 85–100      | 2.000.000        | 2,0 %    |

### Vetos y techos (importante para no confundir el total con el nivel)

- **Veto por ROAS:** si `roasValue < 3.0` → nivel `no_eligible` **sin importar el
  total** (y `scoreStatus = "vetoed_roas"`).
- **Veto por buró:** banda `veto` → `no_eligible` y `eligibilityStatus = "vetoed_bureau"`.
- **Techo por eficiencia (ROAS cap):** el nivel final nunca supera lo que el
  subscore ROAS habilita (Growth exige sRoas ≥ 65, Pro ≥ 80, Elite ≥ 92). Solo
  recorta hacia abajo. Cuando recorta: `tier ≠ tierByScore` y `tierCappedBy = "roas"`.
- **Buró `high_risk`:** fuerza la comisión a la máxima de la escala (3,5 %), pero
  no cambia el nivel.

Por eso el snapshot trae **`tierByScore`** (nivel solo por puntos) **y `tier`**
(nivel final ya recortado). Para la UI, el nivel "vigente" es `tier`.

---

## 3. Los dos ejes de estado

Nunca uses un solo campo para decidir qué mostrar. Hay **dos ejes
independientes**:

**`scoreStatus`** — ¿se pudo calcular el score?
- `scored` — calculado OK.
- `vetoed_roas` — ROAS bajo el mínimo → no elegible.
- `insufficient_data` — la cuenta Meta/Dropi es más nueva que el período.
- `fx_unavailable` — no había tasa de cambio para convertir la moneda.

**`eligibilityStatus`** — gate de buró sobre el resultado:
- `eligible` — apto.
- `bureau_pending` — score OK pero falta el check de buró (banda `null`).
- `vetoed_bureau` — buró bloquea.
- `not_applicable` — no aplica (p. ej. score no calculado).

Para una insignia única en la UI, combinalas (ver §6).

---

## 4. Acceso a la API

- **Base URL (vía gateway, por ambiente):**
  `https://app.roaxai.dev/payments` (local) ·
  `https://app.dev.roaxai.com/payments` (dev) ·
  `https://app.stg.roaxai.com/payments` (stg) ·
  `https://app.roaxai.com/payments` (prod).
  Nunca pegar a IPs internas.
- **Prefijo de ruta:** todos los endpoints cuelgan de `/v1/credit/...`.
  Ejemplo completo: `GET https://app.dev.roaxai.com/payments/v1/credit/scores/brand/:brandId`.
- **Auth:** sesión/JWT del usuario. El backend valida pertenencia a la marca y
  **permiso RBAC** por endpoint (ver audiencias abajo).
- **Envoltura de respuesta:** todo viene como `{ "data": ... }` (las listas
  agregan `total`, `page`, `pageSize`).

### Audiencias y permisos (importante)

Hay **dos fronts** con accesos muy distintos. El backend lo enforce con
`CreditPermissionGuard` + permisos RBAC contra `backend-roles` (fail-closed):

| Audiencia                          | Qué puede consumir                                                  | Permiso requerido         |
| ---------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| **Front externo / cliente** (app)  | **Solo `GET /preapproval/:brandId`** — y siempre **vía BFF**        | Solo auth + miembro de la marca |
| **Admin / panel interno**          | Todo: cálculo, scores, historial, ranking, **runs**, escala, buró   | `credit:runs` / `credit:scale` / `credit:bureau` |

> ⚠️ **El front externo NO dispara runs ni ve snapshots crudos.** Calcular y
> disparar runs masivos es **exclusivo de admin** (`credit:runs`). Un usuario
> cliente no tiene ese permiso → recibe **403**. Lo único pensado para el cliente
> es el **pre-aprobado curado** (§5.4), que oculta score crudo, banda de buró e
> insumos (habeas data) y se sirve a través del BFF, nunca pegando directo a
> payments.

---

## 5. Endpoints

Cada endpoint marca su audiencia: **[ADMIN]** requiere permiso RBAC;
**[CLIENTE]** es lo único que el front externo puede consumir (vía BFF).

### 5.1 [ADMIN] Último score de una marca · `credit:runs`
`GET /v1/credit/scores/brand/:brandId`

Devuelve el snapshot más reciente. `404 { code: "noScores" }` si la marca no
tiene scores. Respuesta `{ data: <Snapshot> }` (ver forma completa abajo).

### 5.2 [ADMIN] Historial de una marca (para graficar evolución) · `credit:runs`
`GET /v1/credit/scores/brand/:brandId?latest=false`

Devuelve hasta **100 snapshots** ordenados por `createdAt` DESC.
Respuesta `{ data: <Snapshot>[] }`. **Esta es la serie temporal del score.**

### 5.3 [ADMIN] Ranking / scores de un run · `credit:runs`
`GET /v1/credit/scores?runId=<uuid>&page=1&pageSize=50`

Lista de snapshots ordenados por `total` DESC (ranking). `pageSize` máx 200.
Respuesta `{ data: <Snapshot>[], total, page, pageSize }`.

### 5.4 [CLIENTE] Pre-aprobado (curado, vía BFF)
`GET /v1/credit/preapproval/:brandId`

**El único endpoint para el front externo.** Versión amigable y **sin datos
sensibles** (no expone score crudo, banda de buró ni insumos). Solo pide auth +
pertenencia a la marca (roles owner/admin/financiero), sin permiso `credit:*`.
Debe consumirse **a través del BFF**, no pegando directo a payments. Respuesta
`{ data: <Preapproval> }`:

```jsonc
{
  "brandId": "59e9...",
  "status": "eligible",        // eligible | in_review | not_eligible | no_data
  "tier": "starter",           // null si no se muestran términos
  "amount": 1000000,           // desembolso; null si no aplica
  "weeklyQuota": 3000000,      // cupo semanal; null si no aplica
  "commission": 0.035,         // fracción; null si no aplica
  "currency": "COP",
  "updatedAt": "2026-05-31T..."
}
```

### 5.5 [ADMIN] Runs masivos · `credit:runs`
**Solo admin.** El front externo no dispara ni consulta runs.
- `GET /v1/credit/runs` → `{ data: <Run>[] }` (recientes).
- `GET /v1/credit/runs/:id` → `{ data: <Run> }` (progreso/polling).
- `POST /v1/credit/runs` body `{ periodStart, periodEnd }` → `202 { data: <Run> }`.
  Los períodos son **meses completos**, `periodEnd` **exclusivo** (primer día del
  mes siguiente al último a evaluar). Ej.: mayo 2026 = `{ "2026-05-01", "2026-06-01" }`.
  `409 { code: "runAlreadyActive" }` si ya hay un run `pending|running` del período.

### 5.6 [ADMIN] Cálculo individual · `credit:runs`
`POST /v1/credit/scores/calculate` body `{ brandId, periodStart, periodEnd }` →
`{ data: <Snapshot> }`. Recalcula el score de una sola marca (admin).

### 5.7 [ADMIN] Escala activa (umbrales para graficar) · `credit:scale`
`GET /v1/credit/config/scales` → `{ data: { config: <ScaleConfig>, version } }`.
Trae pesos, tramos, vetos, tier caps y niveles de la versión activa.

---

## 6. Formas de datos (TypeScript)

```ts
// Un insumo monetario: crudo + moneda + fx + convertido a base (COP).
interface MonetaryInput {
  raw: number
  currency: string
  fxRate: number | null
  fxRateDate: string | null   // ISO date
  converted: number | null    // null si no había fx (fx_unavailable)
}

// Snapshot de score (credit_score). Inmutable.
interface CreditScore {
  id: string
  brandId: string
  runId: string | null              // null = cálculo manual (no parte de un run)
  scaleVersion: number

  periodStart: string               // YYYY-MM-DD pedido
  periodEnd: string                 // YYYY-MM-DD exclusivo
  effectiveStart: string            // recortado a la vida de la cuenta
  effectiveEnd: string
  periodAdjusted: boolean           // true si effective ≠ pedido

  inputs: {
    adSpend: MonetaryInput
    revenueMeta: MonetaryInput      // informativo (Meta billing), fuera del score
    salesDelivered: MonetaryInput
  }

  subscores: {
    investment: number              // 0–100
    roas: number                    // 0–100
    sales: number                   // 0–100
    roasValue: number               // ratio crudo (ej. 4.38)
  }

  total: number                     // 0–100

  tierByScore: string               // nivel solo por puntos
  tier: string                      // nivel final (ya recortado por ROAS cap)
  tierCappedBy: 'roas' | null       // por qué se recortó (si aplica)

  conditions: {
    disbursement: number            // monto en COP
    weeklyQuota: number             // = disbursement * 3
    commission: number | null       // fracción (0.035 = 3.5%); null = no elegible
  }

  bureauCheckId: string | null
  bureauBand: 'veto' | 'high_risk' | 'medium_risk' | 'clear' | null

  scoreStatus: 'scored' | 'vetoed_roas' | 'insufficient_data' | 'fx_unavailable'
  eligibilityStatus: 'eligible' | 'vetoed_bureau' | 'bureau_pending' | 'not_applicable'

  calculatedAt: string              // ISO datetime
  triggeredBy: string               // 'manual:<userId>' | 'manual:server' | run...
  createdAt: string
  updatedAt: string
}

// Run masivo (score_run).
interface ScoreRun {
  id: string
  periodStart: string
  periodEnd: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  totalBrands: number
  processed: number
  eligible: number
  vetoed: number
  insufficient: number
  errors: number
  triggeredBy: string
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}
```

---

## 7. Qué graficar (sugerencias)

> La mayoría de estas visualizaciones son del **panel admin** (consumen
> endpoints `[ADMIN]`). El **front externo / cliente** solo grafica los términos
> del **pre-aprobado** (§5.4): estado, monto, cupo y comisión. No tiene acceso al
> score crudo, subscores, historial ni runs.

| Visualización                  | Datos                                                                 | Endpoint            |
| ------------------------------ | --------------------------------------------------------------------- | ------------------- |
| **Gauge / medidor del total**  | `total` (0–100) con bandas de color por rango de `tier`               | 5.1                 |
| **Insignia de estado**         | combinar `scoreStatus` + `eligibilityStatus` (ver abajo)              | 5.1                 |
| **Breakdown de subscores**     | radar o barras de `subscores.investment / roas / sales` (0–100)       | 5.1                 |
| **Términos del nivel**         | `tier`, `conditions.disbursement / weeklyQuota / commission`          | 5.1 o 5.4 (cliente) |
| **Evolución temporal**         | serie de `total` (y/o cada subscore) vs `calculatedAt`                | 5.2 (`latest=false`)|
| **Progresión de nivel**        | timeline de `tier` por snapshot; marcar saltos                        | 5.2                 |
| **Insumos del período**        | `inputs.adSpend.converted`, `salesDelivered.converted`, `roasValue`   | 5.1 / 5.2           |
| **Distribución de un run**     | dona con `eligible / vetoed / insufficient / errors` de un `ScoreRun` | 5.5                 |
| **Progreso de run (live)**     | barra `processed / totalBrands`, polling cada ~2 s mientras `running` | 5.5                 |

### Insignia de estado sugerida (precedencia)

```ts
function statusBadge(s: CreditScore): { label: string; tone: 'green'|'yellow'|'red'|'gray' } {
  if (s.scoreStatus === 'insufficient_data') return { label: 'Datos insuficientes', tone: 'gray' }
  if (s.scoreStatus === 'fx_unavailable')   return { label: 'Sin tasa de cambio',   tone: 'gray' }
  if (s.scoreStatus === 'vetoed_roas')      return { label: 'No elegible (ROAS)',    tone: 'red' }
  if (s.eligibilityStatus === 'vetoed_bureau')  return { label: 'No elegible (buró)', tone: 'red' }
  if (s.eligibilityStatus === 'bureau_pending') return { label: 'En revisión',        tone: 'yellow' }
  if (s.eligibilityStatus === 'eligible')       return { label: 'Elegible',           tone: 'green' }
  return { label: 'No elegible', tone: 'red' }
}
```

### Notas de UI

- **`total` ≠ nivel elegible.** Una marca puede tener `total = 90` pero `tier =
  no_eligible` por veto de ROAS/buró. Mostrar siempre el estado junto al número.
- Cuando `tierCappedBy === 'roas'`, conviene un tooltip: "Nivel limitado por
  eficiencia (ROAS); mejora el ROAS para subir de nivel".
- Cuando `periodAdjusted === true`, indicar que el período real evaluado
  (`effectiveStart`–`effectiveEnd`) es más corto que el pedido (cuenta nueva).
- `commission` es una **fracción**: formatear como `commission * 100 + '%'`.
- Para la app del cliente usar **5.4 (`preapproval`)**, que ya oculta lo sensible;
  reservar los snapshots completos (5.1/5.2) para el admin / panel interno.
```

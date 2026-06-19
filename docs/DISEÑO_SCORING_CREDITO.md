# Diseño: Scoring de Crédito ROAX

> Estado: diseño aprobado y revisado contra el código — listo para implementar
> Fecha: 2026-06-11 (rev. 2 tras revisión de arquitectura del mismo día)
> Spec de negocio: `servers/roax-credito_2.html` (v1.0)
> Alcance de este documento: cálculo, almacenamiento y consulta del score de crédito
> por marca. El ciclo operativo (desembolsos, tarjeta Dropi Pay, recaudo prioritario,
> bloqueos) es una fase posterior que consume lo aquí definido y NO se diseña aquí.

## Contexto

ROAX Crédito financia pauta de Meta Ads a marcas de ecommerce: desembolsos cada 2 días
vía tarjeta virtual de uso exclusivo en Meta, repagados automáticamente desde el recaudo
COD de la wallet Dropi en ciclos de 8 días. El score determina si una marca es elegible,
cuánto puede recibir por desembolso y qué comisión paga.

Este documento corrige y precisa la spec original, que contiene errores conocidos:

| Punto | Spec original | Decisión final |
|-------|---------------|----------------|
| Sujeto del score | "usuario" | **Marca** (`brand_id` string, sin FK cross-service) |
| Moneda | Solo COP | **Moneda de la marca**, convertida a moneda base de la escala |
| Escala ROAS | Dos escalas contradictorias (tarjeta visual vs simulador JS) | **La del simulador JS** (más granular) |
| Numerador del ROAS | `billing` autoreportado por Meta | **Ventas ENTREGADAS de Dropi** (ROAS real entregado÷spend) |
| Ventas | "facturación mensual" | **Órdenes Dropi `status = 'ENTREGADO'`** (COD efectivamente cobrado) |
| Período | Implícito (mensual / 3 meses) | **Parámetro del caller**, meses calendario completos en COT |
| Buró | Datacrédito hardcodeado | **Provider abstracto** con bandas configurables + consentimiento habeas data |
| Niveles altos | Sin requisito de ROAS | **Techo de nivel por subscore ROAS** (confirmado) |

---

## 1. Modelo de scoring

### 1.1 Fórmula

```
score = round( s_inversion × 0.40 + s_roas × 0.40 + s_ventas × 0.20 )
```

Tres variables con peso + un gate (buró) que no suma puntos. Todos los pesos, tramos,
vetos y techos viven en configuración versionada en BD (`score_scale_config`), nunca
en código.

### 1.2 Escalas (autoritativas — paridad con el simulador JS de la spec)

Los tramos son `[min, max)` sobre el **promedio mensual** del período, expresado en la
moneda base de la escala (COP en v1).

**Inversión en pauta Meta — peso 40%** (`scoreInv` del simulador)

| Inversión mensual | Subscore |
|---|---|
| < $2.000.000 | 10 |
| $2M – $4M | 30 |
| $4M – $6M | 50 |
| $6M – $10M | 70 |
| $10M – $18M | 85 |
| ≥ $18M | 100 |

**ROAS REAL del período — peso 40%** (`scoreRoasFn` del simulador)

| ROAS | Subscore |
|---|---|
| < 1.5x | 0 |
| 1.5 – 2.0x | 15 |
| 2.0 – 2.5x | 30 |
| 2.5 – 3.0x | 50 |
| 3.0 – 3.5x | 65 |
| 3.5 – 4.5x | 80 |
| 4.5 – 6.0x | 92 |
| ≥ 6.0x | 100 |

> ROAS < 3.0x es **veto duro** (no elegible). Los tramos por debajo de 3.0 existen solo
> para mostrar "qué tan lejos está" la marca; nunca habilitan crédito.
>
> **ROAS REAL del período = `sum(ventas entregadas Dropi) / sum(spend Meta)`** ponderado
> sobre todo el período — NUNCA promedio de ROAS mensuales (sobre-pondera meses de bajo
> gasto y es manipulable).
>
> **No se usa el `billing` autoreportado por Meta.** En un modelo COD/Dropi la atribución
> de pixel de Meta es poco fiable (y empíricamente llega en 0 en los insights), y lo que
> importa para repagar el crédito es el dinero EFECTIVAMENTE cobrado al entregar. Por eso
> el numerador del ROAS es la venta ENTREGADA de Dropi, igual que el pilar de ventas. La
> diferencia entre ambos pilares: el ROAS mide **eficiencia** (entregado ÷ gasto), el
> pilar de ventas mide **volumen** absoluto entregado. `revenue_meta`/`billing` se sigue
> reportando como dato informativo/auditoría (comparar atribución Meta vs real), pero NO
> entra en el score.

**Volumen de ventas entregadas — peso 20%** (`scoreVent` del simulador)

| Ventas mensuales (entregadas/cobradas Dropi) | Subscore |
|---|---|
| < $5.000.000 | 10 |
| $5M – $10M | 30 |
| $10M – $20M | 50 |
| $20M – $40M | 70 |
| $40M – $70M | 88 |
| ≥ $70M | 100 |

> "Ventas" = órdenes Dropi con `status = 'ENTREGADO'`, no órdenes creadas. En un modelo
> donde el recaudo COD repaga el crédito, lo que importa es lo que efectivamente entra a
> la wallet.
>
> **Diferencia intencional con el "GMV válido" del resto del código**: los reportes
> existentes usan `status NOT IN (RECHAZADO, CANCELADO, ANULADO, GUIA_ANULADA)`, que
> incluye devoluciones y órdenes en tránsito. Para crédito se cuenta SOLO `ENTREGADO`.
> No "corregir" esto para igualarlo a los reportes — es a propósito.

### 1.3 Niveles y techo por ROAS (confirmado 2026-06-11)

Nivel por puntos:

| Nivel | Score | Desembolso | Cupo semanal (3×) | Comisión |
|---|---|---|---|---|
| No elegible | 0 – 39 | — | — | — |
| Starter Ads | 40 – 54 | $1.000.000 | $3.000.000 | 3.50% |
| Builder | 55 – 64 | $1.500.000 | $4.500.000 | 3.00% |
| Growth Seller | 65 – 74 | $2.000.000 | $6.000.000 | 2.50% |
| Pro Marketer | 75 – 84 | $2.000.000 | $6.000.000 | 2.25% |
| Elite | 85 – 100 | $2.000.000 | $6.000.000 | 2.00% |

**Techo de nivel por subscore de ROAS** — el nivel final es
`min(nivel_por_puntos, techo_por_roas)`:

| Subscore ROAS | ROAS real | Nivel máximo |
|---|---|---|
| 65 | 3.0 – 3.5x | Growth Seller |
| 80 | 3.5 – 4.5x | Pro Marketer |
| 92 / 100 | ≥ 4.5x | Elite |

Racional: desde Growth Seller el desembolso es idéntico ($2M) — el techo **nunca recorta
capacidad de crédito** (la fija el score total, que captura el flujo de repago), solo
evita dar el precio mínimo a quien no demostró eficiencia. Capacidad la gobierna el
riesgo; precio lo gobierna la eficiencia. Además hace verdadera la descripción de la
spec ("Pro Marketer: alta eficiencia publicitaria demostrada"), que sin techo era falsa
(una marca con ROAS 3.1x e inversión/ventas máximas llegaba a Elite con 86 pts).

Cuando el techo actúa, el snapshot guarda ambos niveles (`tier_by_score` y `tier`) y la
causa (`tier_capped_by: roas`). El admin lo muestra explícito:
*"86 pts → Elite por puntos, limitado a Growth Seller por ROAS 3.2x"*.

Los montos de desembolso están definidos **por moneda** en la config de niveles. V1
siembra solo COP; para otros mercados negocio define montos redondos equivalentes
(no se convierte al vuelo — nadie quiere una tarjeta cargada con $487.32 USD).

### 1.4 Gate de buró

El buró no suma puntos: produce una **banda** que actúa sobre el resultado.

| Banda | Efecto |
|---|---|
| `veto` | No elegible, sin importar el score |
| `high_risk` | Elegible, comisión forzada al máximo (3.5%) sin importar nivel |
| `medium_risk` | Elegible, comisión normal, bandera visible en admin |
| `clear` | Sin efecto |

Los umbrales que mapean puntaje crudo → banda son **config por provider** (para
Datacrédito: `{ veto_below: 300, high_risk_below: 500, medium_risk_below: 600,
scale_max: 950 }`). El motor de score solo conoce las cuatro bandas normalizadas.

### 1.5 Mejoras evaluadas y pospuestas

- **Interpolación lineal dentro de los tramos** (elimina acantilados tipo ROAS 3.49 →
  65 vs 3.50 → 80, que cambian comisión por un centésimo y generan reclamos e incentivo
  a manipular). Pospuesta a v2: los escalones dan paridad exacta con el simulador
  validado por negocio y son más fáciles de explicar/auditar.

---

## 2. Moneda

- El 40% del score (ROAS) es adimensional — no requiere conversión. Solo inversión
  (40%) y ventas (20%) comparan montos contra umbrales.
- La escala se define en una **moneda base** (`base_currency: COP` en v1) dentro de
  `score_scale_config`.
- Los insumos Meta **ya llegan en moneda de marca**: el sync convierte spend/billing de
  moneda del ad account → moneda de marca al persistir (`syncAd.service.ts`). NO
  re-convertir por ad account; solo aplicar una conversión marca → base sobre el
  agregado. Las órdenes Dropi tienen `currency` propia por orden (`inte_dropi_order`):
  el endpoint de insumos debe validar que coincide con la moneda de marca y convertir
  (o reportar el mismatch) cuando no.
- **Tasa de conversión = la del día del cálculo, congelada en el snapshot.** Decisión
  consciente (rev. 2): la tabla `currency_exchange_rate` tiene `@Unique(from, to)` y el
  cron diario actualiza in-place — **no existe histórico de tasas**, así que un promedio
  del período es irrealizable hoy. La reproducibilidad de un score histórico la
  garantiza el **snapshot** (que persiste monto crudo + moneda + tasa usada + fecha de
  la tasa + monto convertido), no el recálculo. Limitación aceptada: recalcular el mismo
  período en otra fecha puede dar un score distinto si la tasa se movió — el snapshot
  original sigue siendo el válido para la decisión que se tomó con él. Si negocio
  exige tasa promedio del período, se requiere primero una tabla histórica
  `currency_exchange_rate_daily` poblada por el cron (trabajo nuevo en processes, v2).
- **Tasa faltante = estado terminal, nunca 1:1.** El `getRate()` actual de processes
  devuelve `1` en silencio cuando no encuentra el par (`currency.service.ts`) — una
  marca en MXN sin par cargado tendría sus montos tratados como COP y un score inflado
  ~20x sin alarma. El endpoint de insumos **no debe usar ese fallback**: devuelve
  `fxToBase.rate: null` cuando no hay tasa, y el motor produce `score_status:
  fx_unavailable` (no elegible, visible en admin).
- La config de escala admite **overrides por moneda** (umbrales propios por mercado)
  cuando negocio los defina. V1: una sola escala base + conversión.

---

## 3. Período de análisis y cobertura de datos

- El período es **parámetro del caller** (`period_start`, `period_end`). El sistema
  valida que sean **meses calendario completos** y rechaza períodos que incluyan días
  del mes en curso (la regla la impone el sistema, no la disciplina del operador).
- **Timezone canónico: COT (America/Bogota) para v1.** Los límites de mes se interpretan
  como `[inicio_de_mes_local, inicio_de_mes_siguiente_local)`. Importa porque los datos
  no están en UTC crudo: las órdenes Dropi se anclan al timezone del país
  (`utcOfCountry(created_at, country)` en el sync) y los insights Meta usan el
  `date_start` del ad account. Filtrar bordes en UTC desalinearía hasta 5 horas de
  órdenes contra cómo processes ancló los datos. El endpoint de insumos hace el filtro
  coherente con el anclaje de cada fuente; cuando haya mercados fuera de COT, el
  timezone pasa a ser atributo del mercado de la marca.
- Presets en admin: "mes anterior" y "3 meses anteriores".
- Umbrales mensuales → el motor normaliza: `mensual = total_período / nº_meses`.
- **El backfill cubre integraciones nuevas**: al conectar Meta/Dropi, el sync trae ~3
  meses de historia desde el origen. La edad de la *integración* es irrelevante para
  el período pedido.
- `insufficient_data` solo aplica cuando la **cuenta en el origen** (ad account Meta /
  tienda Dropi) es más nueva que el período — no hay historia que backfillear porque
  no existe. Detección: el endpoint de insumos devuelve metadata de cobertura
  (`meta_first_data_at`, `dropi_first_data_at`; donde Meta lo exponga, `created_time`
  de la ad account). La **política** sobre esa metadata vive en payments.
- **Período efectivo**: si la cuenta es más joven que el período pedido, se calcula
  sobre la intersección (período ∩ vida de la cuenta) redondeada a meses calendario
  completos, mínimo 1 mes. El snapshot registra período pedido vs efectivo + bandera
  `period_adjusted`. Por debajo de 1 mes completo → `insufficient_data`. Esto permite
  puntuar en onboarding: marca nueva en Roax con cuenta Meta vieja se puntúa el día
  uno; cuenta Meta de 6 semanas se puntúa con su primer mes completo.
- Cuenta con historia completa pero `spend = 0` **no** es `insufficient_data`: es una
  marca que no invierte → ROAS indefinido → `vetoed_roas`. Son estados distintos y el
  admin los muestra distinto.

---

## 4. Buró abstracto (Datacrédito es solo un provider)

Mismo patrón multi-provider del resto de payments (`src/provider/`):

```typescript
interface BureauProvider {
  getScore(document: string, documentType: string, country: string):
    Promise<{ rawScore: number; scale: number; raw: unknown; checkedAt: Date }>
}
```

- **Providers v1**: `manual` (un operador del admin carga el puntaje obtenido por
  fuera — fallback permanente para países sin buró integrado, no un hack temporal) y
  `datacredito` cuando haya API contratada.
- La consulta es por **documento legal** (NIT/cédula del titular), no por marca: el
  resultado puede compartirse entre marcas del mismo titular. Por eso `bureau_check`
  es entidad propia referenciada desde el score, keyed por documento.
- **Consentimiento habeas data — regla dura (rev. 2).** Consultar centrales de riesgo
  en Colombia exige autorización previa, expresa e informada del titular (Ley 1266 de
  2008 + Ley 1581 de 2012; sancionable por la SIC). `credit_profile` registra
  `consent_granted_at`, `consent_version`, `consent_source`. **Ningún
  `BureauProvider.getScore()` se ejecuta sin consentimiento vigente registrado** — la
  regla se valida en el service, no en el controller. El provider `manual` exige la
  misma constancia (la consulta externa también requirió autorización del titular).
  El consentimiento se captura junto con el documento legal en el onboarding (flujo a
  coordinar con platform, Fase 5).
- **Caché con vigencia**: las consultas cuestan dinero. `bureau_check.valid_until`
  (default 30 días, configurable); el motor reusa checks vigentes. Historial completo
  para auditoría.
- Marca sin check vigente = `eligibility_status: bureau_pending`: el score se calcula
  y se muestra, la elegibilidad queda pendiente. Permite correr el batch sobre ~5K
  marcas sin pagar 5K consultas de buró.
- **La carga manual de buró es un vector de fraude interno** (un operador podría
  inyectar banda `clear` y habilitar crédito): requiere permiso RBAC explícito +
  registro en `AuditService` (§8). Doble control (maker-checker) deseable cuando el
  producto maneje montos relevantes.

---

## 5. Estados del resultado (dos ejes, rev. 2)

Un solo campo `status` no puede representar estados concurrentes (una marca puede ser
vetada por ROAS **y** no tener buró vigente a la vez). Se separan dos ejes:

**`score_status`** — resultado del cálculo:

| Valor | Significado |
|---|---|
| `scored` | Score calculado normalmente |
| `vetoed_roas` | ROAS < 3.0x o spend = 0 (ROAS indefinido) |
| `insufficient_data` | Cuenta origen más nueva que 1 mes completo del período |
| `fx_unavailable` | Sin tasa de conversión para la moneda de la marca |

**`eligibility_status`** — gate de buró aplicado sobre el resultado:

| Valor | Significado |
|---|---|
| `eligible` | Score ≥ 40, sin veto, buró `clear`/`medium_risk`/`high_risk` |
| `vetoed_bureau` | Buró en banda `veto` |
| `bureau_pending` | Sin check de buró vigente |
| `not_applicable` | El score ya es terminal (`vetoed_roas`/`insufficient_data`/`fx_unavailable` o score < 40) |

**Precedencia** (qué reporta el admin como causa principal):
`fx_unavailable` > `insufficient_data` > `vetoed_roas` > score < 40 > `vetoed_bureau` >
`bureau_pending` > `eligible`. Así el admin puede decir "no elegible por ROAS 2.8x;
buró no evaluado" sin ambigüedad.

---

## 6. Arquitectura

Regla del monorepo: cada micro su BD, comunicación solo por endpoints HTTP, IDs
cross-service como string sin FK.

```
┌──────────────────┐  POST /v1/metrics/credit-inputs/batch   ┌──────────────────────┐
│ backend-processes │ ◄──────────────────────────────────────│ backend-payments      │
│  (insumos crudos) │ ─────────────────────────────────────► │  src/credit/          │
│  inte_meta_*      │   agregados + currency + cobertura      │  motor + snapshots +  │
│  inte_dropi_order │   auth: Bearer ACCESS_SERVER             │  buró + runs + tiers  │
│  currency_exch_*  │                                         └──────────┬───────────┘
└──────────────────┘                                                     │ consulta
                                                              ┌──────────▼───────────┐
                                                              │ admin (tab Crédito +  │
                                                              │ página Score Runs)    │
                                                              └──────────────────────┘
```

### 6.1 backend-processes — endpoint de insumos (sin lógica de crédito)

Processes reporta hechos; no conoce pesos, vetos ni niveles.

```
POST /v1/metrics/credit-inputs/batch
body: { brandIds: string[], periodStart: 'YYYY-MM-DD', periodEnd: 'YYYY-MM-DD' }
→ por marca:
{
  brandId, currency,                    // moneda de la marca
  adSpend,                              // SUM(spend)   inte_meta_ad_insights WHERE time='day'
  revenueMeta,                          // SUM(billing) — INFORMATIVO; el ROAS NO lo usa
  salesDelivered,                       // SUM(price)   inte_dropi_order WHERE status='ENTREGADO'
                                        //   → numerador del ROAS REAL (entregado/spend) Y pilar de ventas
  coverage: { metaFirstDataAt, dropiFirstDataAt, adAccountCreatedAt? },
  fxToBase: { currency: 'COP', rate: number | null, rateDate }   // null = sin tasa, NUNCA 1 por defecto
}
```

Precisión de los agregados (verificado contra el código, rev. 2):

- **`WHERE time = 'day'` es obligatorio** en `inte_meta_ad_insights`: la tabla mezcla
  granularidades `all/day/week/month/year` en la columna `time`
  (`@Unique(['refId','time','since'])`). Sumar sin ese filtro **duplica o multiplica
  todo el spend y el revenue**. Es el error más fácil de cometer de toda la Fase 1.
- El revenue Meta es la columna **`billing`** (derivada de
  `action_values → onsite_web_purchase` en el sync). No existe `purchase_value`.
- Las uniones marca↔cuentas ya existen: `brand_inte_meta_account_adaccount` (Meta) y
  `brand_inte_dropi_account` (Dropi). El agregado de entregadas por marca ya está casi
  resuelto en SQL en `breakdown.controller.ts` (`FILTER (WHERE o.status='ENTREGADO')`)
  — partir de ahí, no diseñar de cero.
- `fxToBase.rate = null` cuando no hay par de monedas — el endpoint NO usa el fallback
  `getRate() → 1` de `currency.service.ts` (§2).
- Batch paginado (lotes ~100) — el worker de payments consume páginas, nunca 5.000
  requests individuales (lección del bug N+1 del MCP sobre 5K marcas).
- Endpoint adicional de descubrimiento: listado paginado de marcas con integraciones
  Meta+Dropi activas (para que el run masivo sepa a quién puntuar), sobre las mismas
  tablas puente.
- **Auth**: el endpoint se monta detrás del `AuthMiddleware` de processes con
  `Authorization: Bearer ${ACCESS_SERVER}` — el mismo patrón server-to-server que ya
  usa payments en `src/client/client-roles.service.ts`. Decisión explícita: se acepta
  el token de servicio compartido en v1; si se quiere reducir el blast radius, un
  token dedicado por servicio es mejora futura.

### 6.2 backend-payments — módulo `src/credit/`

- **Motor de score**: función pura table-driven —
  `(inputs, scaleConfig, bureauBand) → resultado`. Sin fechas internas, sin I/O.
  Los breakpoints del simulador JS de la spec son la suite de tests de paridad.
- **Config versionada e inmutable**: cambiar la política crea `scale_version` N+1;
  nunca se edita una versión usada. Todo snapshot referencia su versión.
- **Runs batch durables con BullMQ** (rev. 2): payments ya tiene `@nestjs/bullmq`
  (patrón `WorkerHost` en `src/webhook/webhook.processor.ts`). La tabla `score_run`
  da progreso/polling (como SpendModule), pero la ejecución va en cola BullMQ — el
  fire-and-forget in-process de SpendModule pierde el job ante un restart, inaceptable
  para un run de 5K marcas. Nota: no existe `src/queue/` genérico; el processor vive
  en el módulo credit.
- **Cliente de processes** en `src/client/` (mismo patrón que `client-roles.service.ts`).

### 6.3 Concurrencia e idempotencia de runs (rev. 2)

- **Un solo run activo por período**: guard que rechaza (409) crear un `score_run` si
  ya existe uno `pending|running` para el mismo `(period_start, period_end)`.
- **Worker idempotente por marca**: los snapshots son inmutables y keyed por
  `(brand_id, run_id)` (constraint único). Al reintentar/reanudar un run, el worker
  salta marcas que ya tienen `credit_score` con ese `run_id`. Un run que murió a mitad
  se reanuda sin duplicar ni recalcular lo hecho.
- Los contadores del run (`processed`, `eligible`, ...) se derivan de los snapshots del
  run, no se mantienen como única fuente de verdad.

---

## 7. Modelo de datos (BD payments)

```
score_scale_config
  id, version (unique), base_currency, status (draft|active|retired)
  config jsonb {
    weights: { investment: 0.40, roas: 0.40, sales: 0.20 },
    scales: { investment: [...], roas: [...], sales: [...] },   // tramos [min, score]
    vetoes: { min_roas: 3.0 },
    tier_roas_caps: { growth_seller: 65, pro_marketer: 80, elite: 92 },
    tiers: [...],                       // por moneda: score range, desembolso, comisión
    currency_overrides: { ... }         // opcional, v2
  }
  created_at, created_by

bureau_check
  id, provider (manual|datacredito|...), document, document_type, country
  raw_score, scale_max, band (veto|high_risk|medium_risk|clear)
  raw jsonb, checked_at, valid_until, created_by

credit_profile
  id, brand_id (string, unique), document, document_type, country
  consent_granted_at, consent_version, consent_source       -- habeas data (rev. 2)
  status (active|suspended), created_at, updated_at

score_run
  id, period_start, period_end, status (pending|running|completed|failed)
  total_brands, processed, eligible, vetoed, insufficient, errors
  triggered_by (manual:{userId} | cron), created_at, finished_at
  -- guard: único run pending|running por (period_start, period_end)

credit_score                            -- snapshot INMUTABLE, nunca se sobreescribe
  id, brand_id, run_id (nullable), scale_version
  -- unique (brand_id, run_id) WHERE run_id IS NOT NULL  → idempotencia del worker
  period_start, period_end              -- pedido
  effective_start, effective_end        -- efectivo (≠ pedido ⇒ period_adjusted)
  period_adjusted boolean
  inputs jsonb        -- { adSpend, revenueMeta, salesDelivered } × { raw, currency, fxRate, fxRateDate, converted }
  subscores jsonb     -- { investment, roas, sales }, roas_value
  bureau_check_id (nullable), bureau_band (nullable)
  total int, tier_by_score, tier, tier_capped_by (nullable: roas)
  conditions jsonb    -- { disbursement, weeklyQuota, commission }  (comisión ya con force de buró)
  score_status (scored | vetoed_roas | insufficient_data | fx_unavailable)
  eligibility_status (eligible | vetoed_bureau | bureau_pending | not_applicable)
  calculated_at, triggered_by
```

Auditabilidad como requisito de diseño: todo score histórico debe poder reconstruirse
con su snapshot (inputs crudos + fx con fecha + versión de escala + check de buró).
Estamos decidiendo darle dinero a alguien — cada decisión que empeora condiciones tiene
que ser explicable en una línea.

**Validación al activar una versión de escala (rev. 2)** — una config inválida activada
corrompe todos los scores futuros. Al pasar `draft → active` se valida:
- pesos suman 1.0;
- tramos de cada escala monótonos, sin huecos ni solapes, cubriendo desde 0;
- `tier_roas_caps` referencian tiers existentes; `min_roas` cae en un borde de tramo ROAS;
- `tiers` cubren 0–100 sin huecos y existe al menos la `base_currency`;
- solo una versión `active` a la vez (al activar, la anterior pasa a `retired`).

---

## 8. Endpoints (payments) y permisos

```
POST  /v1/credit/scores/calculate          { brandId, periodStart, periodEnd }   # individual
GET   /v1/credit/scores/brand/:brandId     ?latest=true | historial paginado
POST  /v1/credit/scores/runs               { periodStart, periodEnd }            # batch — 409 si hay run activo
GET   /v1/credit/scores/runs               listado
GET   /v1/credit/scores/runs/:id           progreso (polling) + resumen agregado
POST  /v1/credit/bureau/checks             { brandId, provider, rawScore? }      # manual o trigger API
GET   /v1/credit/bureau/checks/brand/:brandId
GET   /v1/credit/config/scales             versiones
POST  /v1/credit/config/scales             nueva versión (draft → active, con validación §7)
```

**RBAC (rev. 2)** — hoy payments **no tiene guard de rol efectivo** (los `@UseGuards()`
de admin están vacíos; solo se verifica usuario autenticado). Para crédito eso es
inaceptable: cargar un buró manual `clear` habilita crédito. Operaciones que requieren
permiso explícito (guard contra backend-roles, patrón de permiso por endpoint que roles
ya soporta):

| Operación | Riesgo |
|---|---|
| `POST /bureau/checks` (manual) | Fraude interno directo: inyectar banda favorable |
| `POST /config/scales` (activar versión) | Cambiar la política de crédito de todas las marcas |
| `POST /scores/runs` | Operacional (carga sobre processes) |

Todas dejan traza en el `AuditService` existente (`src/audit/`) además de `created_by`.

---

## 9. Admin

**Tab "Crédito" en detalle de marca:**
- Último score con breakdown (3 barras + banda de buró — el simulador de la spec es
  reutilizable casi 1:1 como visual).
- Historial de snapshots (fecha, período, score, nivel, score/eligibility status).
- Botón **Recalcular** con selector de período (presets mes anterior / 3 meses).
- Sección buró: check vigente, vencimiento, consentimiento registrado, consultar /
  cargar manual (con permiso).
- Cuando hay techo: mostrar ambos niveles y la causa. Cuando hay estado no-elegible:
  mostrar la causa principal según la precedencia de §5.

**Página "Score Runs":**
- Botón **"Calcular todos los scores"** + selector de período → crea run, responde
  de inmediato, progreso por polling.
- Resumen del run: distribución por nivel, vetos, sin datos, sin fx — le sirve a
  negocio para calibrar la escala contra la base real (~5K marcas).

---

## 10. Verificación contra el código (rev. 2)

Supuestos del diseño verificados en el monorepo antes de implementar:

| Supuesto | Veredicto | Evidencia |
|---|---|---|
| Revenue para ROAS | ✅ **ventas entregadas Dropi** (NO `billing` de Meta) — billing llega 0 en COD | `order.entity.ts`, smoke 2026-06-17 |
| `billing` Meta (informativo) | ⚠️ existe pero 0 en datos reales locales — solo auditoría, fuera del score | `adInsights.entity.ts`, `syncAd.service.ts` |
| Granularidad insights | ⚠️ exige `WHERE time='day'` | `@Unique(['refId','time','since'])` en `adInsights.entity.ts` |
| Ventas entregadas | ✅ `inte_dropi_order.status='ENTREGADO'`, monto en `price`, `currency` por orden | `order.entity.ts`, `breakdown.controller.ts` |
| Puentes marca↔cuentas | ✅ `brand_inte_meta_account_adaccount`, `brand_inte_dropi_account` | entidades meta/brand y SQL existente |
| Fx histórico | ❌ no existe (Unique por par, update in-place) → tasa del día congelada en snapshot | `currencyExchangeRate.entity.ts`, `currency.service.ts` |
| Fx faltante | ⚠️ `getRate()` devuelve 1 silencioso → el endpoint no usa ese fallback | `currency.service.ts` |
| Conversión Meta multi-moneda | ✅ ya resuelta en sync (ad account → marca) | `syncAd.service.ts` |
| Cola durable en payments | ✅ BullMQ presente, patrón `WorkerHost` | `package.json`, `webhook.processor.ts` |
| Patrón batch+polling | ✅ SpendModule (pero es fire-and-forget → se reemplaza por BullMQ) | `spend.service.ts` |
| Auth server-to-server | ✅ `Bearer ACCESS_SERVER` ya usado por payments | `client-roles.service.ts` |
| Auditoría en payments | ✅ `AuditService` existente | `src/audit/` |
| RBAC en payments | ❌ guards vacíos — hay que construir el guard de permisos | `admin.controller.ts` |

---

## 11. Fases de implementación

### Fase 1 — Insumos (backend-processes)
- Endpoint batch `credit-inputs` (contrato §6.1: `time='day'`, `billing`, `ENTREGADO`,
  fx nullable, cobertura, timezone COT) + endpoint de descubrimiento.
- Reutilizar tablas puente y SQL de `breakdown.controller.ts`.
- Auth `ACCESS_SERVER` detrás del AuthMiddleware existente.

### Fase 2 — Motor + snapshots (backend-payments)
- Migraciones: `score_scale_config`, `credit_profile`, `credit_score` (con unique
  `(brand_id, run_id)`), `bureau_check`.
- Motor puro + seed de la escala v1 (valores de este doc) + validación draft→active.
- Tests de paridad contra el simulador JS + casos: techo, vetos, dos ejes de status,
  precedencia, period_adjusted, insufficient_data, fx_unavailable, conversión.
- `POST /calculate` individual + `GET` por marca.

### Fase 3 — Runs batch
- `score_run` + processor BullMQ en el módulo credit, consumiendo el endpoint batch
  paginado. Guard de run único activo por período + reanudación idempotente.
- Cron mensual opcional (día 1, mes cerrado) — mismo mecanismo, `triggered_by: cron`.

### Fase 4 — Admin
- Tab Crédito + página Score Runs.

### Fase 5 — Buró + RBAC
- Guard de permisos contra backend-roles (carga manual de buró, activar escala,
  disparar runs) + trazas en AuditService.
- Provider `manual` + carga desde admin con permiso. `datacredito` cuando haya
  contrato/API.
- Captura de documento legal **y consentimiento habeas data** de la marca (coordinar
  con platform) — regla dura: sin consentimiento no hay consulta de buró.

### Fuera de alcance (fase posterior, otro doc)
- Línea de crédito, desembolsos, tarjeta Dropi Pay, abono prioritario en wallet,
  verificación cada 2 días, bloqueos, ciclo de 8 días, interés diario.

---

## 12. Decisiones registradas

| Fecha | Decisión |
|---|---|
| 2026-06-11 | Sujeto = marca; moneda = la de la marca; período = parámetro (meses completos) |
| 2026-06-11 | Escala ROAS del simulador JS confirmada como autoritativa |
| 2026-06-11 | Ventas = órdenes Dropi `ENTREGADO` (no el "GMV válido" de reportes) |
| 2026-06-17 | ROAS REAL = ventas entregadas Dropi ÷ spend Meta (no el `billing` autoreportado por Meta; en COD billing es 0 e poco fiable). `billing` queda informativo |
| 2026-06-11 | Techos de nivel por subscore ROAS confirmados (65→Growth, 80→Pro, 92→Elite) |
| 2026-06-11 | Backfill de 3 meses cubre integraciones nuevas; `insufficient_data` solo si la cuenta origen es más nueva que el período |
| 2026-06-11 | Split processes (insumos) / payments (dominio de crédito); buró abstracto multi-provider |
| 2026-06-11 (rev. 2) | Fx = tasa del día de cálculo congelada en snapshot (no hay histórico de tasas); tasa faltante = `fx_unavailable`, nunca 1:1 |
| 2026-06-11 (rev. 2) | Estados en dos ejes (`score_status` + `eligibility_status`) con precedencia explícita |
| 2026-06-11 (rev. 2) | Consentimiento habeas data obligatorio antes de cualquier consulta de buró (Leyes 1266/1581) |
| 2026-06-11 (rev. 2) | Runs en BullMQ (no fire-and-forget), run único activo por período, idempotencia por `(brand_id, run_id)` |
| 2026-06-11 (rev. 2) | Timezone canónico COT para límites de mes |
| 2026-06-11 (rev. 2) | RBAC explícito para buró manual / activar escala / runs + AuditService |

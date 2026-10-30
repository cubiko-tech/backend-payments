# Riesgos de backend-payments

Una entrada por riesgo, corta (R33). El archivo nace con el primer riesgo y se borra la entrada
cuando se cierra y ya no hay código que la sostenga: la historia queda en el commit.

## Un país sin fila de precio propia pasa a cobrarse en dólares en vez de ser rechazado

- **Dónde**: `src/client/client-roles.service.ts:173` (la caída a `findUsdRow`)
- **Qué lo dispara**: un alta o un checkout de una marca cuyo país no tiene fila en `plan_prices`,
  para cualquier plan que sí tenga una fila en dólares.
- **Qué rompe**: hasta RXDEV-13 esa alta se rechazaba con `PRICE_NOT_FOUND_FOR_COUNTRY`, y el rechazo
  servía de freno: un país donde todavía no se decidió vender no podía cobrar. Ahora cobra en dólares.
  Alcanza también al checkout general de `starter`, `pro` y `enterprise`, que comparte el resolvedor.
  El monto y la moneda salen de la MISMA fila, así que no puede cobrar un monto en pesos como dólares.
- **Estado**: mitigado por el alcance — sólo cae a una fila que el catálogo declara, nunca a la de otro
  país en su moneda, y sin fila en dólares sigue rechazando. Abierto en lo comercial: decidir dónde NO
  vender ya no se expresa omitiendo la fila del país; hay que quitar la fila en dólares del plan.

## Una recarga de wallet acredita también el impuesto como saldo (C1)

- **Dónde**: `src/checkout/checkout.service.ts:583-590` y `:618-635` (`finalizeProcessingPayment`,
  invocado desde `completeExternalPayment` en `:563`)
- **Qué lo dispara**: una recarga (`purpose: wallet_recharge`) en un país con impuesto no incluido en el
  precio (CO 19%, MX 16%) cuando el proveedor confirma el pago.
- **Qué rompe**: si se acreditara `totalAmount` en vez de `subtotal`, la marca recibiría el IVA como
  saldo gastable mientras la factura declara subtotal e impuesto por separado.
- **Estado**: mitigado (criterio C1, release 002) — `finalizeProcessingPayment` calcula
  `subtotal = totalAmount - taxAmount` antes de acreditar y llama a
  `walletService.credit(payment.walletId, subtotal, …)` con llave `payment:${payment.id}:credit`
  (`src/checkout/checkout.service.ts:590`, `:619-626`).

## Completar un pago externo puede acreditar dos veces (C2)

- **Dónde**: `src/checkout/checkout.service.ts:546-567` (`completeExternalPayment`, invocado también
  desde `reconcilePayment` en `:724` y `:742-745`) y `:655-662` (`finalizeProcessingPayment`)
- **Qué lo dispara**: el webhook del proveedor y `POST /v1/checkout/:id/reconcile` (o dos entregas del
  mismo webhook) corriendo a la vez sobre un pago que sigue en `pending` o `processing`.
- **Qué rompe**: sin reclamo atómico del estado, dos ejecuciones concurrentes ejecutarían dos veces el
  crédito de wallet, la suscripción y la factura.
- **Estado**: mitigado (criterio C2, release 002 y LOC-32) — `completeExternalPayment` descarta llamadas
  en vuelo sobre el mismo `paymentId` (`src/checkout/checkout.service.ts:547-548`), reclama el pago hacia
  `PaymentStatus.PROCESSING` con `paymentRepo.update({ id: paymentId, status: payment.status }, …)`
  (`:554-561`) y sólo marca `PaymentStatus.COMPLETED` tras acreditar y emitir factura (`:655-662`).

## El cobro y el crédito de wallet no tienen llave de idempotencia (C2)

- **Dónde**: `src/wallet/wallet.service.ts:98-170` (`credit`) y `:190-336` (`debit`); columna
  `idempotencyKey` en `src/transaction/entities/transaction.entity.ts:33`
- **Qué lo dispara**: un reintento del mismo cobro o crédito con la misma `idempotencyKey`.
- **Qué rompe**: sin restricción única en base de datos, un reintento volvería a sumar o restar el saldo
  y dejaría dos filas en `transactions` para el mismo hecho.
- **Estado**: mitigado (criterio C2, release 002 y LOC-14) — `transactions.idempotencyKey` tiene índice
  `unique: true` (`src/transaction/entities/transaction.entity.ts:33`), `credit` devuelve el movimiento
  existente ante colisión única (`src/wallet/wallet.service.ts:160-163`) y `debit` lo recupera bajo el
  bloqueo de la wallet antes de validar estado o saldo (`:223-229`) y en los respaldos por saldo o
  restricción única (`:289-295`, `:327-330`).

## Un pago de servicio puede debitar una wallet de otra moneda o de tokens (C3)

- **Dónde**: `src/checkout/checkout.service.ts:211-213`, `:333-346` y `:1058-1093`
  (`assertWalletCurrency`)
- **Qué lo dispara**: un `POST /v1/checkout` con `provider: 'wallet'` y `purpose: 'service_payment'`
  (o `wallet_recharge`) cuya `currency` no coincide con la de la wallet, o cualquier checkout que apunte
  a una wallet en `TKN`.
- **Qué rompe**: cuando la guarda sólo corría en `plan_purchase`, un `service_payment` en USD podía
  debitar 50 unidades de una wallet en COP y emitir factura en USD, o intentar cobrar contra una wallet
  de tokens (`TKN`).
- **Estado**: mitigado en checkout (criterio C3, LOC-4) — `processCheckout` ejecuta
  `assertWalletCurrency` en todo cobro con wallet (`src/checkout/checkout.service.ts:211-213`), rechaza
  con 422 `WALLET_CURRENCY_MISMATCH` cualquier wallet `TKN` o moneda distinta (`:1077-1092`), y
  `processWalletPayment` pasa siempre `currency` como cuarto argumento a `walletService.debit` (`:345`).

## `WalletService.debit` no exige `walletId` ni pertenencia de la wallet a la marca (C3)

- **Dónde**: `src/wallet/wallet.service.ts:190-255` (`debit`) y `src/tasks/tasks.service.ts:456-459`,
  `:528-531`
- **Qué lo dispara**: una llamada directa a `walletService.debit` (por ejemplo desde `renewFromWallet` en
  `src/tasks/tasks.service.ts:1172-1184` o desde un consumidor interno) con `walletId` vacío/`undefined`,
  con una wallet de otra `brandId` o con una wallet en `TKN`.
- **Qué rompe**: TypeORM ignora condiciones `undefined` en `findOne({ where: { id: walletId } })` y
  bloquea la primera wallet de la tabla; además, sin validar `wallet.brandId` ni moneda `TKN`, `debit`
  podría descontar saldo de una wallet ajena o de tokens, y una renovación con `walletId: null` quedaba
  omitida en vez de marcarse fallida.
- **Estado**: mitigado (criterio C3, LOC-5 y LOC-15) — `debit` exige `walletId` no vacío y `amount`
  finito mayor que cero antes de abrir la transacción (`src/wallet/wallet.service.ts:197-209`), verifica
  que la wallet bloqueada pertenezca a `txData.brandId` cuando se informa la marca (`:238-243`), rechaza
  wallets o cobros en `TKN` (`:245-255`), y `processSubscriptionRenewals` / `retryFailedPayments`
  encaminan toda suscripción `provider === 'wallet'` a `renewFromWallet`
  (`src/tasks/tasks.service.ts:456-459`, `:528-531`), donde un `walletId` nulo falla con
  `MISSING_WALLET_ID` (`:1124-1129`).

## La renovación por wallet pide precio fijo en COP, omite la moneda en `debit` y `processWalletPayment` oculta fallos del débito (C3)

- **Dónde**: `src/tasks/tasks.service.ts:1123-1221` (`renewFromWallet`),
  `src/checkout/checkout.service.ts:310-383` (`processWalletPayment`) y
  `src/wallet/wallet.service.ts:325-333` (`debit`)
- **Qué lo dispara**: el cron de renovación cobrando por wallet una suscripción cuya marca tiene precio
  en otra moneda (por ejemplo USD), o un fallo devuelto como `{ error }` o excepción por
  `walletService.debit`.
- **Qué rompe**: cuando `renewFromWallet` pedía precio fijo en `'COP'` y llamaba a `walletService.debit`
  sin `expectedCurrency`, podía debitar pesos sobre una wallet en dólares o al revés; además, si
  `processWalletPayment` no inspeccionaba `debitResult.error` y reetiquetaba toda excepción como
  `INSUFFICIENT_BALANCE`, ocultaba el código real del rechazo o completaba pagos con débito fallido.
- **Estado**: mitigado (criterio C3, LOC-6) — `renewFromWallet` resuelve la moneda de la wallet con
  `resolveWalletCurrency` (`src/tasks/tasks.service.ts:1140`, `:1235-1249`), consulta
  `getPlanPrice(sub.planSlug, currency)` (`:1141`), rechaza la moneda sin precio con
  `WALLET_CURRENCY_MISMATCH` (`:1159-1165`) y pasa `currency` a `walletService.debit` verificando
  `debitResult.error` (`:1172-1192`); `WalletService.debit` relanza errores tras el rollback
  (`src/wallet/wallet.service.ts:325-333`) y `processWalletPayment` preserva `RequestException` o
  envuelve fallos inesperados como `WALLET_DEBIT_FAILED` (`src/checkout/checkout.service.ts:347-354`,
  `:372-382`).

## Una renovación ya debitada en wallet queda sin extender su período local mientras `backend-roles` rechace el cambio de plan (LOC-14)

- **Dónde**: `src/tasks/tasks.service.ts:1139`, `:1196-1198`, `:1223-1233` (`renewFromWallet`,
  `hasCycleDebit`) y `:1413-1439` (`extendSubscriptionPeriod`)
- **Qué lo dispara**: una renovación por wallet cuyo débito del ciclo
  (`subscription:${sub.id}:${billingCycleKey}`) ya se asentó, pero `clientRoles.renewPlanForBrand`
  (`src/tasks/tasks.service.ts:1418-1422`) devuelve `false`.
- **Qué rompe**: `extendSubscriptionPeriod` corta antes de avanzar `currentPeriodEnd` y
  `nextBillingDate` (`src/tasks/tasks.service.ts:1423-1437`) para conservar la llave del ciclo y no
  enviar a `handleRenewalFailure` una suscripción que ya pagó. Mientras `backend-roles` siga devolviendo
  `false`, `hasCycleDebit` (`:1139`) saltea la consulta de precio y la ventana de aplazamiento
  (`:1140-1193`), dejando la suscripción con `nextBillingDate` vencida en `backend-payments` y
  reintentando `extendSubscriptionPeriod` en cada corrida horaria.
- **Estado**: mitigado en doble cobro, degradación y carrera entre crons (LOC-14 y LOC-33) —
  `hasCycleDebit` (`src/tasks/tasks.service.ts:1139`, `:1223-1233`) evita debitar dos veces,
  `processSubscriptionRenewals` y `expireLockedSubscription` excluyen `retryCount >= MAX_RETRY` de la
  renovación (`:438`, `:444`, `:1441-1454`) y toman `acquireSubscriptionLock` por suscripción (`:447`,
  `:629`, `:1473-1531`), y el rechazo de `backend-roles` se registra en `error` con `sub.id`
  (`:1423-1428`). Abierto en convergencia: si `backend-roles` rechaza de forma permanente esa marca o
  plan tras el débito, la extensión local se reintenta cada hora sin cota hasta que
  `renewPlanForBrand` devuelva `true`.

## El aplazamiento de renovación por falta de precios sólo corre con caché frío y el caché tibio sirve precios vencidos sin tope (LOC-16)

- **Dónde**: `src/tasks/tasks.service.ts:153`, `:1143-1166`, `:1461-1471` (`renewFromWallet`,
  `isPostponementGraceExceeded`) y `src/client/client-roles.service.ts:94-96`, `:187-211`
  (`hasCachedPrices`, `getPlanRows`)
- **Qué lo dispara**: una caída de `backend-roles` durante la renovación por wallet, ya sea con el
  proceso recién iniciado (`this.cache === null`) o después de haber cargado precios en memoria al menos
  una vez.
- **Qué rompe**: con caché frío (`!hasCachedPrices()` en `src/tasks/tasks.service.ts:1145-1147`),
  `renewFromWallet` pospone el cobro (`return false` en `:1157`) manteniendo la suscripción `active` sin
  cobrar durante la ventana de gracia; en cambio, si el proceso ya tenía caché en memoria, `getPlanRows`
  sirve `this.cache.prices` vencido sin edad máxima (`src/client/client-roles.service.ts:201-205`) y
  `hasCachedPrices()` devuelve `true` (`:94-96`), por lo que se cobra al último precio cacheado o, si esa
  moneda no existía en aquel snapshot, se rechaza de inmediato con `WALLET_CURRENCY_MISMATCH`
  (`src/tasks/tasks.service.ts:1159-1165`).
- **Estado**: mitigado en el aplazamiento indefinido con caché frío (LOC-16 y LOC-33) —
  `renewFromWallet` registra `error` con `sub.id` (`src/tasks/tasks.service.ts:1148-1151`) y acota la
  espera a 24 h (`RENEWAL_POSTPONEMENT_GRACE_HOURS` en `:153`, `isPostponementGraceExceeded` en
  `:1152-1156`, `:1461-1471`) antes de lanzar error y pasar la suscripción a `past_due` (`:486-489`).
  Abierto sobre caché vencido: `getPlanRows` (`src/client/client-roles.service.ts:201-205`) no tiene tope
  de antigüedad cuando `backend-roles` cae después de la primera carga.

## El servicio deja de arrancar si `ACCESS_SERVER` o `JWT_SECRET` falta, vale `CHANGEME` o tiene espacios al borde (LOC-56)

- **Dónde**: `src/main.ts:11-24` (`requireStartupSecret`, `bootstrap`)
- **Qué lo dispara**: iniciar el proceso con `ACCESS_SERVER` o `JWT_SECRET` ausente, vacío, igual a
  `CHANGEME` o con espacios al principio o al final.
- **Qué rompe**: antes `bootstrap` no exigía `ACCESS_SERVER` al arrancar ni rechazaba `CHANGEME` o
  espacios al borde en `JWT_SECRET` y `ACCESS_SERVER`; si un ambiente conserva el placeholder `CHANGEME`
  de `.env-template`, omite `ACCESS_SERVER` o tiene espacios accidentales en los extremos, el arranque
  aborta antes de escuchar en el puerto 80.
- **Estado**: abierto — verificar que `JWT_SECRET` y `ACCESS_SERVER` tengan valores distintos de
  `CHANGEME` y sin espacios al borde en la configuración de cada ambiente antes de desplegar.

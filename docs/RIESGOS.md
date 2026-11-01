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

## Pago `completed` sin `checkoutResult` en `409` y reintentos con `Idempotency-Key` (LOC-86)

- **Dónde**: `src/checkout/checkout-idempotency.ts:37-67`, `:169-187`
  (`canRetryFailedIdempotentPayment`, `createIncompleteIdempotentCheckoutException`,
  `resolvePaymentStateOutcome`), `src/checkout/checkout.service.ts:360-443`, `:466-634`, `:672-738`
  (`retryFailedIdempotentPayment`, `processWalletPayment`, `processExternalPayment`),
  `src/payment/payment.service.ts:79-107` (`cancelPayment`) y `src/provider/dropi/dropi.provider.ts:57`,
  `:71-90` (`createCheckout`)
- **Qué lo dispara**: (a) un reintento con la misma `Idempotency-Key` cuando el intento anterior alcanzó
  `status = 'completed'` y falló después del cierre, en la lectura de la suscripción o en
  `auditService.log`, sin `metadata.checkoutResult` (`src/checkout/checkout.service.ts:584-599`), si el
  proceso cayó antes del `update` final con `checkoutResult` (`:601-610`), o cuando un pago externo fue
  completado por webhook o reconciliación sin haber guardado `metadata.checkoutResult`; (b) un reintento
  con la misma `Idempotency-Key` sobre un pago
  externo `failed` con `metadata.idempotencyFingerprint` y sin `providerPaymentId`; (c) un reintento en
  `POST /checkout` sobre una fila `payments` que la ruta retirada `POST /payment/checkout` (eliminada en
  `c77a594`, LOC-93) ya hubiera escrito antes de su retiro con `metadata.idempotencyFingerprint`,
  `subtotal`, `taxAmount` y `amount` provistos por el cliente y pasada a `failed` vía
  `POST /payment/:id/cancel` (`src/payment/payment.service.ts:96-98`).
- **Qué rompe**: (a) `resolvePaymentStateOutcome` rechaza con `409 IDEMPOTENT_CHECKOUT_INCOMPLETE`
  (`src/checkout/checkout-idempotency.ts:58-67`, `:182-187`) de forma permanente para esa llave, con el
  cobro ya efectuado y sin camino de recuperación desde la misma `Idempotency-Key`; (b) el reintento de un
  pago externo `failed` sin `providerPaymentId` invoca otra vez `provider.createCheckout`
  (`src/checkout/checkout.service.ts:680-690`), donde en Dropi (`src/provider/dropi/dropi.provider.ts:57`,
  `:71-90`) se ejecuta `POST /charges` con timeout de 15 s sin llave de idempotencia hacia el proveedor:
  si el proveedor creó el cobro y la respuesta venció antes de guardar `providerPaymentId`, el reintento
  deja un segundo cobro pendiente (hipótesis, R14: no se ejercitó contra Dropi y no consta que cree el
  cobro cuando la respuesta vence); (c) las filas que `POST /payment/checkout` ya hubiera escrito antes de
  su retiro siguen siendo elegibles al reintento en `canRetryFailedIdempotentPayment`
  (`src/checkout/checkout-idempotency.ts:37-42`) y `retryFailedIdempotentPayment` reutiliza sus importes
  almacenados (`src/checkout/checkout.service.ts:387-401`); esas filas no se contaron por ambiente.
- **Estado**: mitigado en reintentos de pagos `failed` con huella verificada y cobros por wallet (LOC-86)
  — `canRetryFailedIdempotentPayment` (`src/checkout/checkout-idempotency.ts:37-42`) exige
  `metadata.idempotencyFingerprint` no vacío, ausencia de `providerPaymentId` y ausencia de
  `metadata.amountMismatch`, `retryFailedIdempotentPayment` reclama la fila con
  `UPDATE ... WHERE id = :id AND status = 'failed'` (`src/checkout/checkout.service.ts:357-365`), y el
  débito en wallet usa la llave determinística `payment:${payment.id}:debit` (`:484`). Abierto en los tres
  bordes de arriba: un pago `completed` sin `metadata.checkoutResult` devuelve siempre `409
IDEMPOTENT_CHECKOUT_INCOMPLETE` para esa llave, un timeout en `provider.createCheckout` antes de
  persistir `providerPaymentId` puede abrir una segunda sesión o cobro pendiente en el proveedor externo, y
  las filas que `POST /payment/checkout` ya hubiera escrito antes de `c77a594` (LOC-93) siguen siendo
  elegibles al reintento y no se contaron por ambiente.

## Reconciliación de pagos `wallet` en `PROCESSING` ante plan posterior, fallos o checkout lento en vuelo (LOC-87, LOC-96)

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:203-256`, `:276-300`, `:315-387`,
  `:415-512`, `:514-608` (`hasWalletPaymentRefund`, `findConflictingPlanSubscription`,
  `refundSupersededWalletPayment`, `completeReconciledWalletPayment`, `reconcileWalletPayment`),
  `src/tasks/tasks.service.ts:620-670`, `:676-721` (`reconcileWalletPayments`,
  `expirePendingCheckouts`), `src/checkout/checkout.service.ts:466-634`, `:1962-1970`
  (`processWalletPayment`, `assignPlanInRoles`) y `src/client/client-roles.service.ts:314-321`,
  `:351-385` (`assignPlanToBrand`, `callRolesApi`)
- **Qué lo dispara**: (a) un pago `wallet` de `plan_purchase` cuyo débito `payment:${payment.id}:debit` ya
  se asentó en `transactions` pero quedó en `pending` o `processing` mientras la suscripción de la marca
  está en otro plan (`planSlug !== payment.purposeId`) y su `lastPaymentId` apunta a un pago en `payments`
  más nuevo que éste (`lastTime > paymentTime`, esté la suscripción `active` o `expired`), y durante la
  devolución `walletService.credit` falla (p. ej. wallet `closed` o fallo de base); (b) un pago
  `wallet` con débito asentado en `pending` o `processing` cuando durante el barrido
  `createOrRenewSubscription` (`src/checkout/wallet-payment-close.ts:186`) lanza excepción; (c) `assignPlanInRoles`
  (`src/checkout/checkout.service.ts:1962-1970`) cuando `clientRoles.assignPlanToBrand`
  (`src/client/client-roles.service.ts:314-321`) recibe respuesta no exitosa o excepción en
  `callRolesApi` (`:378-384`) y devuelve `false` sin relanzar error;
  (d) un proceso que muere entre el commit de `closeWalletPayment`
  (`src/checkout/wallet-payment-close.ts:159-210`) y `assignPlanInRoles`
  (`src/checkout/checkout.service.ts:583-589`, `src/checkout/wallet-payment-reconciliation.ts:460-466`);
  (e) un pago `failed` con débito que lleva más de 30 días (`WALLET_FAILED_DEBIT_LOOKBACK_MS`) sin poder
  acreditarse; (f) dos compras de planes distintos que se solapan y la más vieja cierra primero
  (`src/checkout/wallet-payment-close.ts:53-76`); (g) un `failed` con débito cuyo plan ya se aplicó
  (`src/checkout/wallet-payment-reconciliation.ts:567-572`).
- **Qué rompe**: (a) si `walletService.credit` falla al devolver un pago superado por otro plan más nuevo,
  `refundSupersededWalletPayment` (`src/checkout/wallet-payment-reconciliation.ts:315-387`) registra
  `error` (`:332-335`, `:351-353`) y deja la fila en `processing` para reintentarla cada 5 minutos sin
  tope mientras la wallet siga sin aceptar créditos; (b) ante excepción de `createOrRenewSubscription`
  (`src/checkout/wallet-payment-close.ts:186`), la fila permanece en `processing` y
  `reconcileWalletPayments`
  (`src/tasks/tasks.service.ts:620-670`) la reintenta cada 5 minutos hasta `WALLET_CLOSE_GIVE_UP_MS`,
  1 h desde `createdAt`, y ahí se acredita (ver el riesgo siguiente); (c) como `callRolesApi` captura el
  fallo de `backend-roles` (`src/client/client-roles.service.ts:378-384`), si `backend-roles` falla
  durante la reconciliación el
  pago pasa a `completed` con la suscripción creada en `backend-payments` pero sin el plan asignado en
  `backend-roles`;
  (d) el pago queda `completed` con la suscripción guardada y sin el plan en `backend-roles`, y el barrido ya
  no lo mira; (e) el barrido deja de seleccionarlo (`src/tasks/tasks.service.ts:620-650`) y la plata queda
  sin devolver hasta una corrección manual; (f) la compra vieja ya respondió `completed` y publicó su evento,
  y después se acredita y queda `refunded`; (g) no se acredita, deja un log de error en cada pasada y
  espera a una persona, hasta salir de la ventana de 30 días.
- **Estado**: mitigado en pérdida de pagos `wallet` con débito en `pending`/`processing`, pisado de una
  compra posterior en otro plan por el barrido, expiración y carreras entre barridos (LOC-87), y en
  devolución automática a la misma wallet cuando un pago queda superado por una compra más nueva en otro
  plan o cuando el crédito `payment:${payment.id}:refund` ya se había asentado antes de que la marca
  volviera a comprar el mismo plan (LOC-96) — `reconcileWalletPayments`
  (`src/tasks/tasks.service.ts:620-670`) y `reconcileWalletPayment`
  (`src/checkout/wallet-payment-reconciliation.ts:514-608`) completan bajo candado
  `pg_advisory_xact_lock` (`:85-146`) los pagos con débito asentado escribiendo `completed` y
  `metadata.checkoutResult` después del cierre, acreditan el monto de vuelta a la misma wallet con llave
  determinística `payment:${payment.id}:refund` (`:67-69`, `:339-349`), rastro en `audit_log`
  (`wallet_payment_refunded`, `:359-376`) y transición atómica a `refunded` (`:378-386`) tanto cuando
  `lastPaymentId` apunta a un pago más nuevo en otro plan (`:276-300`, `:589-592`) como cuando
  `hasWalletPaymentRefund` detecta que el crédito de reembolso ya existe en `transactions` (`:203-256`,
  `:593-602`), pasan a `failed` los `pending` sin débito fuera de la ventana de 2 minutos (`:544-561`) y
  `expirePendingCheckouts` excluye todo `pending` con débito (`src/tasks/tasks.service.ts:691-701`).
  La carrera con un checkout en vuelo está cerrada (LOC-97): el débito toma el candado del pago y relee su
  estado (`src/wallet/wallet.service.ts:223-251`), un `failed` con débito se acredita sin pasar por un estado
  completable (`src/checkout/wallet-payment-reconciliation.ts:566-575`), el cierre corre bajo un candado por
  marca en una sola transacción, gana el `createdAt` más nuevo y `lastPaymentId` no retrocede
  (`src/checkout/wallet-payment-close.ts:159-210`, `src/checkout/checkout.service.ts:1486-1498`), y un pago
  con débito no se cancela
  (`src/payment/payment.service.ts:81-126`). Abierto sobre la convergencia sin cota cuando
  `walletService.credit` falla de forma permanente, cuando `callRolesApi`
  absorbe un fallo de `backend-roles`, y sobre (d) y (e), que hoy no tienen quien los recupere; los cierra un
  barrido que reasigne el plan de los `completed` recientes y una alerta sobre (e).
  (f) y (g) también siguen abiertos: los cierra avisar a quien compró y una alerta sobre (g).

## Un cierre que sigue fallando a la hora devuelve la plata y deja a la marca sin plan (LOC-99)

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:40`, `:394-413`, `:436-445`
  (`WALLET_CLOSE_GIVE_UP_MS`, `shouldGiveUpOnClose`, `completeReconciledWalletPayment`) y
  `src/checkout/checkout.service.ts:556-562`, `:643-656` (`processWalletPayment`, `handPaymentToSweep`)
- **Qué lo dispara**: (a) el cierre de un pago debitado sigue fallando con el pago a más de 1 h de su
  `createdAt`, también en su primer intento si el barrido llega tarde; (b) además, una compra más vieja de otro
  plan ya se acreditó porque ésta era la más nueva; (c) el cierre falla sobre una compra cedida a `processing`
  con su plan aplicado.
- **Qué rompe**: (a) la plata vuelve a la wallet y la marca no recibe el plan por el que pagó; (b) las dos compras
  terminan `refunded` y la marca queda sin plan; (c) no se acredita y la fila sigue en `processing`, con un log de
  error en cada pasada, hasta que el cierre funcione o intervenga una persona.
- **Estado**: abierto en los tres, sin plata perdida en (a) y (b). Lo cierra avisar a quien compró, una alerta sobre
  (c) y, para la compra cedida y recomprada, LOC-100.

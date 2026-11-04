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

- **Dónde**: `src/wallet/wallet.service.ts:190-255` (`debit`) y `src/tasks/subscription-renewal.ts:113-117`,
  `:173-177`
- **Qué lo dispara**: una llamada directa a `walletService.debit` (por ejemplo desde `renewFromWallet` en
  `src/tasks/wallet-renewal.ts:114-127` o desde un consumidor interno) con `walletId` vacío/`undefined`,
  con una wallet de otra `brandId` o con una wallet en `TKN`.
- **Qué rompe**: TypeORM ignora condiciones `undefined` en `findOne({ where: { id: walletId } })` y
  bloquea la primera wallet de la tabla; además, sin validar `wallet.brandId` ni moneda `TKN`, `debit`
  podría descontar saldo de una wallet ajena o de tokens, y una renovación con `walletId: null` quedaba
  omitida en vez de marcarse fallida.
- **Estado**: mitigado (criterio C3, LOC-5 y LOC-15) — `debit` exige `walletId` no vacío y `amount`
  finito mayor que cero antes de abrir la transacción (`src/wallet/wallet.service.ts:197-209`), verifica
  que la wallet bloqueada pertenezca a `txData.brandId` cuando se informa la marca (`:238-243`), rechaza
  wallets o cobros en `TKN` (`:245-255`), y `processSubscriptionRenewals` / `retryFailedPayments`
  no le pasan a `renewFromWallet` una suscripción `provider === 'wallet'` con `walletId` nulo
  (`src/tasks/subscription-renewal.ts:113-117`, `:173-177`), y si alguna llega ahí falla con
  `MISSING_WALLET_ID` (`src/tasks/wallet-renewal.ts:36-41`).

## Una suscripción de wallet sin `walletId` conserva el plan sin cobrar

- **Dónde**: `src/tasks/subscription-renewal.ts:113-117`, `:173-177`
- **Qué lo dispara**: una fila `provider = 'wallet'`, `autoRenew`, vencida y con `walletId` nulo
- **Qué rompe**: la marca sigue con su plan pago sin que se le cobre, mientras nadie le ponga wallet
- **Estado**: abierto — lo cierra corregir cada fila; el log de error con su id y el contador de la
  pasada la señalan en cada corrida. Cuántas filas hay por ambiente no se contó: se cuenta en la entrega.

## La renovación por wallet pide precio fijo en COP, omite la moneda en `debit` y `processWalletPayment` oculta fallos del débito (C3)

- **Dónde**: `src/tasks/wallet-renewal.ts:34-169` (`renewFromWallet`),
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
  `resolveWalletCurrency` (`src/tasks/wallet-renewal.ts:62`, `:186-198`), consulta
  `getPlanPrice(sub.planSlug, currency)` (`:74`), rechaza la moneda sin precio con
  `WALLET_CURRENCY_MISMATCH` (`:94-100`) y pasa `currency` a `walletService.debit` verificando
  `debitResult.error` (`:114-135`); `WalletService.debit` relanza errores tras el rollback
  (`src/wallet/wallet.service.ts:325-333`) y `processWalletPayment` preserva `RequestException` o
  envuelve fallos inesperados como `WALLET_DEBIT_FAILED` (`src/checkout/checkout.service.ts:347-354`,
  `:372-382`).

## Una renovación ya debitada en wallet queda sin extender su período local mientras `backend-roles` rechace el cambio de plan (LOC-14)

- **Dónde**: `src/tasks/wallet-renewal.ts:60`, `:138-140`, `:172-184` (`renewFromWallet`,
  `hasCycleDebit`) y `:242-300` (`extendSubscriptionPeriod`)
- **Qué lo dispara**: una renovación por wallet cuyo débito del ciclo
  (`subscription:${sub.id}:${billingCycleKey}`) ya se asentó, pero `clientRoles.renewPlanForBrand`
  (`src/tasks/wallet-renewal.ts:249-253`) devuelve `false`.
- **Qué rompe**: `extendSubscriptionPeriod` corta antes de avanzar `currentPeriodEnd` y
  `nextBillingDate` (`src/tasks/wallet-renewal.ts:254-268`) para conservar la llave del ciclo y no
  enviar a `handleRenewalFailure` una suscripción que ya pagó. Mientras `backend-roles` siga devolviendo
  `false`, `hasCycleDebit` (`:60`) saltea la consulta de precio y la ventana de aplazamiento
  (`:62-136`), dejando la suscripción con `nextBillingDate` vencida en `backend-payments` y
  reintentando `extendSubscriptionPeriod` en cada corrida horaria.
- **Estado**: mitigado en doble cobro, degradación y carrera entre crons (LOC-14 y LOC-33) —
  `hasCycleDebit` (`src/tasks/wallet-renewal.ts:60`, `:172-184`) evita debitar dos veces,
  `processSubscriptionRenewals` y `expireLockedSubscription` excluyen `retryCount >= MAX_RETRY` de la
  renovación (`src/tasks/subscription-renewal.ts:97`, `:104`, `:295-307`) y toman
  `acquireSubscriptionLock` por suscripción (`src/tasks/subscription-lock.ts:17-101`),
  y el rechazo de `backend-roles` se registra en `error` con `sub.id`
  (`src/tasks/wallet-renewal.ts:254-260`). Abierto en convergencia: si `backend-roles` rechaza de
  forma permanente esa marca o plan tras el débito, la extensión local se reintenta cada hora sin
  cota hasta que `renewPlanForBrand` devuelva `true`, y el débito queda retenido:
  `refundOrphanRenewalDebits` no lo devuelve mientras la fila siga viva y en ese ciclo (LOC-105).

## El aplazamiento de renovación por falta de precios sólo corre con caché frío y el caché tibio sirve precios vencidos sin tope (LOC-16)

- **Dónde**: `src/tasks/wallet-renewal.ts:19`, `:78-100`, `:302-309` (`renewFromWallet`,
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

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:206-259`, `:279-303`, `:336-408`,
  `:458-554`, `:556-654` (`hasWalletPaymentRefund`, `findConflictingPlanSubscription`,
  `refundSupersededWalletPayment`, `completeReconciledWalletPayment`, `reconcileWalletPayment`),
  `src/tasks/payment-sweep.ts:242-292`, `:294-334` (`reconcileWalletPayments`,
  `expirePendingCheckouts`), `src/checkout/checkout.service.ts:466-629`, `:1961-1969`
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
  (`src/checkout/wallet-payment-close.ts:61-79`); (g) un `failed` con débito cuyo plan ya se aplicó
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
  no lo mira; (e) el barrido deja de seleccionarlo (`src/tasks/tasks.service.ts:621-658`) y la plata queda
  sin devolver hasta una corrección manual; (f) la compra vieja ya respondió `completed` y publicó su evento,
  y después se acredita y queda `refunded`; (g) no se acredita, deja un log de error en cada pasada y
  espera a una persona, hasta salir de la ventana de 30 días.
- **Estado**: mitigado en pérdida de pagos `wallet` con débito en `pending`/`processing`, pisado de una
  compra posterior en otro plan por el barrido, expiración y carreras entre barridos (LOC-87), y en
  devolución automática a la misma wallet cuando un pago queda superado por una compra más nueva en otro
  plan o cuando el crédito `payment:${payment.id}:refund` ya se había asentado antes de que la marca
  volviera a comprar el mismo plan (LOC-96) — `reconcileWalletPayments`
  (`src/tasks/tasks.service.ts:621-678`) y `reconcileWalletPayment`
  (`src/checkout/wallet-payment-reconciliation.ts:556-654`) completan bajo candado
  `pg_advisory_xact_lock` (`:88-149`) los pagos con débito asentado escribiendo `completed` y
  `metadata.checkoutResult` después del cierre, acreditan el monto de vuelta a la misma wallet con llave
  determinística `payment:${payment.id}:refund` (`:70-72`, `:360-370`), rastro en `audit_log`
  (`wallet_payment_refunded`, `:380-397`) y transición atómica a `refunded` (`:399-407`) tanto cuando
  `lastPaymentId` apunta a un pago más nuevo en otro plan (`:279-303`, `:631-634`) como cuando
  `hasWalletPaymentRefund` detecta que el crédito de reembolso ya existe en `transactions` (`:206-259`,
  `:635-644`), pasan a `failed` los `pending` sin débito fuera de la ventana de 2 minutos (`:586-603`) y
  `expirePendingCheckouts` excluye todo `pending` con débito (`src/tasks/tasks.service.ts:699-709`).
  La carrera con un checkout en vuelo está cerrada (LOC-97): el débito toma el candado del pago y relee su
  estado (`src/wallet/wallet.service.ts:223-251`), un `failed` con débito se acredita sin pasar por un estado
  completable (`src/checkout/wallet-payment-reconciliation.ts:608-617`), el cierre corre bajo un candado por
  marca en una sola transacción, gana el `createdAt` más nuevo y `lastPaymentId` no retrocede
  (`src/checkout/wallet-payment-close.ts:175-224`, `src/checkout/checkout.service.ts:1485-1497`), y un pago
  con débito no se cancela
  (`src/payment/payment.service.ts:81-126`). Abierto sobre la convergencia sin cota cuando
  `walletService.credit` falla de forma permanente, cuando `callRolesApi`
  absorbe un fallo de `backend-roles`, y sobre (d) y (e), que hoy no tienen quien los recupere; los cierra un
  barrido que reasigne el plan de los `completed` recientes y una alerta sobre (e).
  (f) y (g) también siguen abiertos: los cierra avisar a quien compró y una alerta sobre (g).

## Un cierre que sigue fallando a la hora devuelve la plata y deja a la marca sin plan (LOC-99)

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:40`, `:415-434`, `:479-492`
  (`WALLET_CLOSE_GIVE_UP_MS`, `shouldGiveUpOnClose`, `completeReconciledWalletPayment`) y
  `src/checkout/checkout.service.ts:556-562`, `:638-651` (`processWalletPayment`, `handPaymentToSweep`)
- **Qué lo dispara**: (a) el cierre de un pago debitado sigue fallando con el pago a más de 1 h de su
  `createdAt`, también en su primer intento si el barrido llega tarde; (b) además, una compra más vieja de otro
  plan ya se acreditó porque ésta era la más nueva.
- **Qué rompe**: (a) la plata vuelve a la wallet y la marca no recibe el plan por el que pagó; (b) las dos compras
  terminan `refunded` y la marca queda sin plan.
- **Estado**: abierto en los dos, sin plata perdida: lo cierra avisar a quien compró. La compra cedida atascada ya no
  llega al cierre: se acredita (LOC-100, `src/checkout/wallet-payment-reconciliation.ts:645-648`). La renuncia reclama
  la fila antes de acreditar (`:440-456`), así que un cierre tardío no deja plan y crédito.

## Una compra externa perdedora no se puede acreditar: tope de wallets (LOC-101, LOC-104)

- **Dónde**: `src/checkout/external-payment-close.ts:221` (`resolveRefundWallet`)
- **Qué lo dispara**: la compra perdió contra una más nueva, la marca no tiene wallet `internal` en esa moneda y ya tiene
  10 wallets.
- **Qué rompe**: la plata cobrada por el proveedor no vuelve: la compra queda `processing` con `lostToNewerPurchase`, sin
  plan ni crédito, y el barrido repite el log de error cada 5 minutos.
- **Estado**: abierto — fuera de alcance por decisión de quien aprueba (2026-11-02): se resuelve a mano. Una wallet
  `internal` cerrada ya no lo dispara: se reabre (LOC-104).

## Una compra desplazada se devuelve entera con hasta 15 minutos de uso (LOC-101, LOC-103)

- **Dónde**: `src/checkout/wallet-payment-close.ts:21` (`PLAN_YIELD_WINDOW_MS`);
  `src/checkout/external-payment-close.ts:79` (`displacedWithinWindow`)
- **Qué lo dispara**: otra compra cambia el plan dentro de los 15 minutos de que ésta aplicó el suyo.
- **Qué rompe**: la marca recibe el total en la wallet aunque usó el plan hasta 15 minutos. Pasado el tope no se devuelve
  nada.
- **Estado**: mitigado por el tope de 15 minutos, confirmado por quien aprueba el 2026-11-02.

## Una compra externa devuelta a la wallet conserva su factura (LOC-101)

- **Dónde**: `src/checkout/checkout.service.ts:905` (`finalizeProcessingPayment`), `src/checkout/wallet-payment-close.ts:83`
  (`yieldOverlappedOlderPurchase`)
- **Qué lo dispara**: la compra ya facturó cuando pierde: cedió después de `completed`, o una más nueva cerró durante las
  llamadas de factura.
- **Qué rompe**: queda una factura, quizá ya enviada a la DIAN, por una compra cuya plata volvió a la wallet; este camino
  no emite nota crédito. La que pierde antes de facturar no genera factura.
- **Estado**: abierto — lo cierra que quien aprueba decida si la devolución exige nota crédito.

## La página de retorno dice «no pudo completarse» de una compra devuelta a la wallet (LOC-101)

- **Dónde**: `src/checkout/checkout.service.ts:975` (`confirmedPaymentAnswer`)
- **Qué lo dispara**: quien compró vuelve del proveedor con una compra que perdió contra una más nueva.
- **Qué rompe**: responde `failed` con `refundedToWallet: true`, y el front aún no lee ese campo: no se avisa que la plata
  está en la wallet. No se pierde plata.
- **Estado**: abierto — lo cierra que `frontend-platform` lea `refundedToWallet`.

## Un barrido que pierde su candado termina en error aunque su trabajo haya quedado hecho (LOC-100)

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:104-124`, `:649-653` (`acquireWalletReconcileLock`,
  el `finally` de `reconcileWalletPayment`)
- **Qué lo dispara**: la conexión del candado del pago muere mientras el barrido trabaja.
- **Qué rompe**: la pasada lanza `Query runner already released`, que tapa su resultado; se ve un error de más en el
  log. No toca la plata: `claimGiveUp` y el reclamo por estado del cierre siguen siendo exclusivos.
- **Estado**: abierto — lo cierra que liberar un candado muerto no lance.

## Los crons sostienen el candado de marca mientras escriben por otras conexiones y llaman por HTTP (LOC-88)

- **Dónde**: `src/checkout/wallet-payment-close.ts:56` (`lockBrandPlan`);
  `src/tasks/subscription-lock.ts:17`, `:79` (`lockAndReread`, `acquireSubscriptionLock`)
- **Qué lo dispara**: bajo el candado corren `getPlanPrice`, `renewPlanForBrand` y `degradeInRoles` (roles),
  `resolveAmountAndCurrency` y `createCheckout` (proveedor, en `issueExternalCharge`) y `confirmarContraElProveedor`
  (ConfioPagos). Basta un checkout o un webhook de la marca mientras un cron procesa su fila; y, para agotar el pool,
  tantos cierres esperando como conexiones tiene (10: default de `pg-pool`, `node_modules/pg-pool/index.js:89`; `src/orm`
  no fija otro).
- **Qué rompe**: un cierre de esa marca espera lo que dure esa fila. Si el pool se agota, **todo el servicio** queda sin
  conexión hasta que venza la espera, porque el cron no consigue una para escribir y soltar el candado.
- **Estado**: mitigado por `lock_timeout` de 30 s en `lockBrandPlan`: la traba dura como mucho eso. Quien vence falla:
  un cierre de wallet queda para el barrido, y un cron no lo cuenta como pago fallido, salvo
  `expireLockedSubscription` (`src/tasks/subscription-expiration.ts:27`), cuya pasada se corta y sigue
  a la hora siguiente. Una espera legítima de más de 30 s (proveedor lento) también falla. Un pago
  externo confirmado que vence el candado queda `processing` hasta que lo termina un barrido (LOC-89):
  `reconcileExternalPayments` si no tiene plan, cuando el proveedor lo confirma, y
  `settleLostExternalPayments` si ya lo tiene.
  Agotar el pool de esta forma no se ejercitó: E9 prueba sólo el vencimiento de un cierre. Abierto lo que lo
  cierra del todo: escribir por la conexión del candado, que pide cambiar `WalletService.debit`.

## Un débito de renovación sin extensión queda huérfano si un checkout mueve la fecha (LOC-88)

- **Dónde**: `src/tasks/renewal-debit-refund.ts:52`, `:74`, `:131` (`canStillExtend`, `refundRenewalDebit`,
  `refundOrphanRenewalDebits`), `src/tasks/wallet-renewal.ts:34`, `:52-58`, `:242`, `:271` (`renewFromWallet`,
  `extendSubscriptionPeriod`)
- **Qué lo dispara**: el cron debita, roles rechaza la renovación y la fila no se extiende; antes de la pasada siguiente
  la marca compra el mismo plan, y eso mueve `nextBillingDate`, de la que sale la llave del ciclo.
- **Qué rompe**: dos cobros y una extensión. Medido sobre Postgres real: 39.800 descontados y 30 días, con precio 19.900.
  No es la carrera del candado: son dos pasadas separadas.
- **Estado**: mitigado por `refundOrphanRenewalDebits`, que acredita el débito una sola vez a su wallet (LOC-105). Queda
  abierto:
  - Marca y fila se guardan en una sola transacción (`:242`, LOC-108), así que una caída antes del commit deja `pending`
    y la fecha sin mover. Hipótesis, sin ejercitar: si la conexión cae durante el COMMIT y éste se aplicó,
    `handleRenewalFailure` escribe la fecha vieja sobre lo confirmado y queda `extended` con la fecha sin mover. Ese débito
    no se devuelve si antes de la pasada siguiente un checkout, una extensión de admin o el cierre de la baja le quitan la
    extensión: el barrido sólo lista `pending`.
  - La guarda de `renewFromWallet` (`:52-58`) deja una fila viva sobre un ciclo ya devuelto sin cobrar, sin extender y
    sin vencer, sólo con un log por hora. Hipótesis, sin ejercitar: se llega por una baja cerrada y devuelta, un `ACTIVE`
    tardío de Confío (`src/webhook/confio-subscription-webhook.service.ts:766-771`) y `reactivate`.
  - Una extensión a mano desde admin sobre una fila con débito `pending` también mueve la fecha: se devuelve el débito y
    quedan los días regalados.

## Una renovación que llega a roles después de la degradación deja plan pago sobre una fila cerrada (LOC-111)

- **Dónde**: `src/tasks/wallet-renewal.ts:250` (`renewPlanForBrand`),
  `src/tasks/subscription-expiration.ts:323` (`degradeInRoles`)
- **Qué lo dispara**: una baja durante la espera a roles y el barrido de acceso, que no toma el candado de plan, cierra la
  fila antes de que la extensión escriba; en roles, la renovación se aplica después de la degradación.
- **Qué rompe**: la marca conserva el plan pago en roles con la fila `cancelled`. El dinero vuelve: el débito queda
  pendiente y el barrido de huérfanos lo devuelve una vez.
- **Estado**: abierto — lo cierra que el barrido de acceso tome el candado de plan, o degradar al abortar la extensión.

## Un guardado de renovación que falla siempre cuesta el plan a quien ya pagó (LOC-108)

- **Dónde**: `src/tasks/wallet-renewal.ts:242` (`extendSubscriptionPeriod`),
  `src/tasks/subscription-renewal.ts:132-135`, `src/tasks/subscription-expiration.ts:38`
- **Qué lo dispara**: falla cada guardado de la extensión y no el de `handleRenewalFailure`. La fila vuelve a ser elegible
  en cada pasada horaria, que no mira el backoff.
- **Qué rompe**: en unas tres horas se agotan los reintentos: la marca recibe avisos de pago fallido y queda vencida.
- **Estado**: aceptado (E8): el cobro se devuelve una vez al cerrar, nunca hay dos. Abierto — lo cierra respetar el backoff en
  esa pasada, si hiciera falta.

## Una renovación cobrada y extendida puede quedar sin su fila en el historial (LOC-108)

- **Dónde**: `src/tasks/wallet-renewal.ts:142-160` (`renewFromWallet`)
- **Qué lo dispara**: falla el guardado del evento `RENEWED` con la extensión ya confirmada.
- **Qué rompe**: el historial de esa suscripción no muestra la renovación; queda sólo el log de error con su id.
- **Estado**: mitigado por ese log; se prefiere a tratarlo como pago fallido, que cobraría dos veces. Abierto — no hay
  reintento del evento.

## Un aviso de Mercado Pago con `ts` a más de 5 minutos se rechaza con 401 (LOC-113)

- **Dónde**: `src/provider/mercadopago/mercadopago.provider.ts:261` (`SIGNATURE_WINDOW_MS`, `:283`)
- **Qué lo dispara**: un reintento de Mercado Pago (cada 15 min, según su doc) que conserve el `ts` original; la doc
  no dice si lo conserva. El `ts` se lee en segundos con 10 dígitos y en milisegundos con 13 o más (`:320`).
- **Qué rompe**: el aviso no entra. El pago lo cierra el barrido `reconcileExternalPayments`
  (`src/tasks/payment-sweep.ts:26`), cada 5 min.
- **Estado**: mitigado por el barrido; abierto — lo cierra ver el primer reintento real de Mercado Pago.

## Mercado Pago sin pago encontrado no distingue «no pagó» de «no lo encuentro» (LOC-89)

- **Dónde**: `src/provider/mercadopago/mercadopago.provider.ts:117`, `:139` (`external_reference`, `getPaymentStatus`)
- **Qué lo dispara**: `payments/search` por `external_reference` devuelve una lista vacía. Pasa con un pago creado antes de
  LOC-89, cuya referencia era `marca:propósito:ts` y no se puede reconstruir, o si la forma real de la respuesta difiere de
  la del falso: no se probó contra una cuenta de prueba.
- **Qué rompe**: el barrido no hace nada y la expiración lo vence a las 24 h, así que un pago cobrado queda `failed`. Tampoco
  lo rescata el webhook, que busca por un id que la fila no guarda (`src/webhook/webhook.service.ts:206-213`).
- **Estado**: abierto — lo cierra probar la búsqueda contra una cuenta de prueba y arreglar el webhook. Una respuesta sin
  `results` lanza y no expira nada.

## Un pago sin respuesta del proveedor se pregunta en cada pasada y no expira (LOC-89)

- **Dónde**: `src/tasks/payment-sweep.ts:26`, `:190` (`reconcileExternalPayments`, `providerLetsExpire`)
- **Qué lo dispara**: un proveedor caído, sin configurar o sin registrar en ese ambiente, con filas `pending` o `processing`.
- **Qué rompe**: las filas no salen y avisan en cada pasada. Las llamadas son en serie, con un tope de 15 a 30 s por fila, así
  que una caída con muchas filas alarga la pasada hasta solaparse con la siguiente. La plata no se toca: el solape lo cubren
  los reclamos por estado y el candado de marca.
- **Estado**: abierto — lo cierra un corte por proveedor dentro de la pasada, si una caída real lo pide.

## Un 404 de un proveedor mal apuntado vence sus pagos (LOC-89)

- **Dónde**: `src/provider/confio/confio.provider.ts:130`, `src/provider/stripe/stripe.provider.ts:86`
  (`ProviderPaymentNotFoundError`)
- **Qué lo dispara**: una configuración de Confío o Stripe que apunte a otro lado. Un 404 se lee como
  «el pago no existe».
- **Qué rompe**: los `pending` de ese proveedor expiran a las 24 h aunque estén cobrados, como antes de LOC-89.
- **Estado**: abierto — lo cierra comprobar la configuración de cada uno, por ambiente, contra su API.

## Mientras Dropi responda 404, sus `pending` no vencen y se acumulan (LOC-102)

- **Dónde**: `src/provider/dropi/dropi.provider.ts:61` (`dropiFetch`); `src/tasks/payment-sweep.ts:190`
  (`providerLetsExpire`); `src/admin/admin.controller.ts:288`
- **Qué lo dispara**: Dropi responde 404 a `/charges/:id`, por una ruta que no existe o por un cobro que de verdad no
  existe: no se distinguen. La QA de LOC-89 lo midió contra el core-back local; qué sirve la API real de Dropi no se
  sabe.
- **Qué rompe**: un `pending` abandonado no vence y la acumulación no tiene tope, hasta que el usuario lo cancela. Cada
  fila es una llamada y un log `error` cada 5 minutos desde los 2 minutos de edad, más uno en cada expiración después de
  las 24 h, y alarga la pasada. `GET admin/payments/pending` muestra los 100 más nuevos, así que puede dejar afuera a
  los demás.
- **Estado**: abierto — lo cierra confirmar la ruta real con el dueño de Dropi.

## Lo que el barrido no rescata o completa sin mirar (LOC-89)

- **Dónde**: `src/tasks/payment-sweep.ts:294`, `:67` (`expirePendingCheckouts`, `settleLostExternalPayments`);
  `src/checkout/checkout.service.ts:1983` (`assertProviderConfirmedAmount`)
- **Qué lo dispara**: (a) se paga justo después de que la expiración leyó `pending` y el webhook se pierde; (b) un `pending` sin
  `providerPaymentId`, por una caída entre `createCheckout` y guardar; (c) un `processing` con plan que el proveedor reembolsó;
  (d) llega un monto distinto cuando el pago ya dio plan, crédito o factura; (e) una instancia trae un monto distinto mientras
  otra aplica el plan y todavía no se ve.
- **Qué rompe**: (a) y (b) quedan `failed`, porque el barrido no mira `failed`; (c) se completa igual, y un `processing` sin
  plan en ese caso sólo deja un log de error en cada pasada; (d) se completa con lo dado y un log de error, sin revertir nada;
  (e) queda `failed` con el plan puesto.
- **Estado**: abierto — (d) y (e) se ven por el log `PROVIDER_AMOUNT_MISMATCH`; lo demás lo cierra una conciliación de `failed`.

## El precio viejo todavía se puede pagar pasadas las 24 h (LOC-98)

- **Dónde**: `src/checkout/checkout.service.ts:715` (`createCheckout` no recibe vencimiento), `:407` (`firstAttemptAt`);
  `src/checkout/checkout-idempotency.ts:235` (el `pending` repite su `checkoutResult`)
- **Qué lo dispara**: (a) un reintento externo aceptado dentro de plazo abre una sesión cuya vida pone el proveedor; (b) un
  `pending` que el barrido no vence porque el proveedor no contesta sigue repitiendo su `checkoutUrl` con la misma llave.
- **Qué rompe**: la compra se completa al monto guardado después de las 24 h. El tope es hipótesis: depende de cada proveedor,
  no se comprobó en ninguno y `expiresAt` no lo acota, porque sólo se escribe. Ninguno de los dos crea un cobro nuevo por sí solo.
- **Estado**: abierto — lo cierra pasarle el vencimiento a cada proveedor, si quien aprueba lo pide.

## Un pago con débito se cierra pasadas las 24 h si se reintenta (LOC-98)

- **Dónde**: `src/checkout/checkout.service.ts:380` (`assertRetryAllowed`)
- **Qué lo dispara**: un `failed` de wallet con débito y sin acreditar, que se reintenta antes de que el barrido lo acredite.
- **Qué rompe**: la compra cierra al precio que ya se cobró, sin segundo débito, en vez de responder vencido.
- **Estado**: mitigado por la exención: decirle «pedido nuevo» a quien ya pagó lo haría pagar dos veces.

## Con el claim `brand` del token se escribe en la suscripción sin consultar a platform y con cualquier rol (LOC-94)

- **Dónde**: `src/subscription/subscription.controller.ts:329-362` (`resolveBrandId`, `sessionBrand`);
  `src/client/client-platform.service.ts:5` (`ALLOWED_BRAND_ROLES`);
  `src/shared/auth/api-auth.guard.ts:93`, `:134` (`payload.brand`, `decodeClaims`)
- **Qué lo dispara**: `POST /subscription/trial`, `/paid`, `/cancel` o `/reactivate` de un
  usuario cuyo token trae `brand`, con esa misma marca en el cuerpo o sin ninguna.
- **Qué rompe**: la escritura pasa sin mirar la membresía ni el rol, mientras la marca nombrada por otra vía exige
  `superuser`, `admin` o `financial`. Un miembro de otro rol cancela la suscripción de su marca. Hipótesis: quien ya
  salió de la marca sigue escribiendo mientras viva su token; no se abrió cuánto dura ni si auth revisa el claim de un
  token de cliente (otro repositorio).
- **Estado**: abierto — lo cierra que quien aprueba decida si el claim basta para escribir. Si no basta,
  `resolveBrandId` consulta `canViewBrandCredit` también con la marca de la sesión.

## Un alta sobre una marca o un usuario ajenos (LOC-53, LOC-75, LOC-77)

- **Dónde**: `src/subscription/subscription.controller.ts:122`, `:158`, `:192-193` (`RequireSuperAdmin`,
  `resolveBrandId`, `req.user.id`); `src/checkout/checkout.controller.ts:79` (`req.user.id`)
- **Qué lo dispara**: un usuario que manda en el cuerpo el `brandId` o el `userId` de otro en `POST /subscription`,
  `/subscription/paid`, `/subscription/trial` o `POST /checkout`.
- **Qué rompe**: el alta quedaría a nombre de una marca o un usuario que no son los de quien la pide.
- **Estado**: cerrado — `userId` de la sesión en `/trial` y checkout (LOC-53, `d43148c`) y en `/paid`
  (LOC-77, `d7a404d`); `POST /subscription` sólo para operador y `/paid` con la marca resuelta (LOC-75, `27a4a45`). El
  principal de servicio sigue pudiendo nombrar ambos, a propósito.

## Una fila wallet sin `nextBillingDate` no se cobra y ningún barrido la saca (LOC-91)

- **Dónde**: `src/tasks/wallet-renewal.ts:44` (`renewFromWallet`), `src/tasks/subscription-renewal.ts:104`
  (`processSubscriptionRenewals`), `src/tasks/subscription-expiration.ts:74` (`expireSubscriptions`),
  `src/tasks/wallet-renewal.ts:51` y `:172` (llave del ciclo, `hasCycleDebit`);
  `src/subscription/subscription.controller.ts:127-133` (`create`), que deja la fecha opcional.
- **Qué lo dispara**: una fila wallet con `autoRenew` y sin fecha, que sale de `POST /subscription` sin el campo o de una
  corrección a mano. Entre ellas, las que ya pagaron: el código anterior a LOC-91 les dejó un débito con llave
  `subscription:<id>:current`.
- **Qué rompe**: la fila no paga y sigue viva: el contador de reintentos no sube, así que no vence. En `past_due` deja un log
  de error en cada reintento; en `active` no la toma ninguna consulta, ni deja log. Si conserva el plan en roles, es servicio
  sin cobrar y sin límite. Hipótesis: el vencimiento del plan en roles no se abrió (otro repositorio), y ese `create` no llama
  a roles, así que acá no consta que tenga uno. La fila con débito `…:current` ya pagó y no recibe período, porque la guarda
  corta antes de `hasCycleDebit`. Y darle fecha la cobra dos veces: la llave cambia, no encuentra ese débito y debita de nuevo.
  Medido sobre Postgres real: saldo esperado 200000, saldo final 150000.
- **Estado**: abierto — lo cierra decidir qué se hace con esas filas (darles fecha o cerrarlas) y exigir la fecha en el alta.
  Antes de darle fecha a una fila se busca su llave `subscription:<id>:current`. Si existe, ese ciclo ya está pagado y no se
  vuelve a cobrar: la corrección tiene que reconocer ese débito. Una fecha futura sola no alcanza en `past_due`, porque el
  reintento no mira la fecha (`retryFailedPayments`, `tasks.service.ts:552-557`) y cobraría con la llave nueva.

## Una nota crédito sin CUFE no se reenvía sola, y el orden del reenvío manual no se comprueba (LOC-106)

- **Dónde**: `src/checkout/refund-credit-note.ts:109` (`sendToDian`); `src/dian/dian.controller.ts:21`
  (POST /dian/send/:invoiceId); `src/dian/dian.service.ts:85`.
- **Qué lo dispara**: la DIAN rechaza la factura o la nota, o el proceso muere tras crear la nota.
- **Qué rompe**: la plata ya está devuelta, pero el documento fiscal no llega. Queda `metadata.dianPending` en la nota y, salvo
  en la caída, `credit_note_dian_failed` en `audit_log`. El envío manual no mira el orden: reenviar la nota sin haber
  mandado su factura la manda sobre un documento que la DIAN no conoce. Primero se envía la factura.
- **Estado**: abierto — no se reintenta a propósito, porque una respuesta perdida duplicaría el documento. Lo cierra un envío
  idempotente ante Siigo. Que admin muestre `dianPending` no se comprobó; `audit_log` sí se consulta ahí.

## Un proceso que muere enviando a la DIAN deja el documento reclamado (LOC-106)

- **Dónde**: `src/dian/dian.service.ts:191` (`claimSend`); `src/dian/dian.controller.ts:26` (`reclaimStale`).
- **Qué lo dispara**: el proceso muere con `metadata.dianSendingAt` puesto. El reclamo ya impide el doble envío en vivo.
- **Qué rompe**: el documento queda sin CUFE y su nota con `dianPending`, sin envío automático. Pasados cinco minutos sólo lo
  retoma el envío manual, y si la DIAN sí lo había recibido, con la respuesta perdida, ese envío lo duplica.
- **Estado**: abierto — lo cierra un envío idempotente ante Siigo. Antes de reenviar a mano se mira en Siigo si el documento llegó.

## El PDF de una nota crédito muestra el UUID de la factura, no su número (LOC-106)

- **Dónde**: `src/invoice/invoice-pdf.service.ts:149`.
- **Qué lo dispara**: descargar el PDF de cualquier nota crédito.
- **Qué rompe**: el documento nombra la factura por un identificador interno. No afecta lo enviado a la DIAN.
- **Estado**: abierto — lo cierra leer `invoiceNumber` de la factura al armar el PDF.

## El payload de Siigo referencia la factura sólo en texto (LOC-106)

- **Dónde**: `src/dian/providers/siigo.provider.ts:255-259`.
- **Qué lo dispara**: cualquier nota crédito enviada a Siigo. Sólo se probó contra `DIAN_PROVIDER=mock`.
- **Qué rompe**: hipótesis, no comprobada: si Siigo exige una referencia estructurada, rechazaría la nota.
- **Estado**: abierto — lo cierra el contador con una prueba contra el sandbox de Siigo.

## Un número de query ausente llega como `NaN` desde que el pipe global convierte tipos (LOC-114)

- **Dónde**: `src/shared/validation/global-validation-pipe.ts:15` (`transform: true`).
- **Qué lo dispara**: un handler nuevo con `@Query('x') x?: number` que pone su valor por defecto con `??`
  o compara con `undefined`. Nest 10.4.22 convierte con `+value`, y `+undefined` es `NaN`
  (`node_modules/@nestjs/common/pipes/validation.pipe.js:131-132`).
- **Qué rompe**: el `NaN` pasa como número a una fecha o a un `take` y da una fecha inválida o un listado
  sin tope. Los 17 handlers de hoy usan `||` y caen al default.
- **Estado**: mitigado por el contrato escrito en el encabezado de la fábrica y el caso
  `admin-extend-body.spec.ts` del default de `expiring`; abierto para el handler que no lo lea.

## El retorno del checkout distingue con 503 si el `paymentId` existe cuando cae `platform`, y el BFF da 500 (LOC-116)

- **Dónde**: `src/checkout/checkout.service.ts:1060-1064` (`reconcilePayment`) y
  `src/checkout/checkout.controller.ts:134-142` (`paymentReturn`).
- **Qué lo dispara**: (a) consultar `GET /v1/checkout/return` mientras `backend-platform` no responde;
  (b) recibir un 400 o 404 desde el BFF de `frontend-platform`
  (`src/app/api/bff/payments/return/route.js:28-30`).
- **Qué rompe**: en (a), un `paymentId` inexistente corta antes con 404 y uno existente consulta
  `canViewBrandCredit` y responde 503 `BRAND_LOOKUP_UNAVAILABLE`, diferenciando que el UUID existe durante la
  caída. En (b), el BFF captura el error y responde 500 a `PaymentReturnView.jsx`.
- **Estado**: en (a), aceptado (UUID v4 no adivinable) para no responderle un falso 404 («Pago no
  encontrado») a la marca dueña ante un parpadeo de `backend-platform`; en (b), abierto en el consumidor
  (`frontend-platform`).

## `RefundService.request` sólo bloquea pagos `refunded` y reembolsos `pending` (LOC-115)

- **Dónde**: `src/refund/refund.service.ts:64-102` (`createPendingRefund`) y `:139-141` (`approve`).
- **Qué lo dispara**: (a) un `POST /v1/refund` sobre un pago en `pending` o `failed`; (b) un segundo
  `POST /v1/refund` después de que `POST /v1/refund/:id/approve` pasó el primero a `processing` sin
  ejecutar la devolución ni cambiar `payments.status` a `refunded`.
- **Qué rompe**: en ambos casos se inserta una fila `pending` en `refunds` (sin mover saldo ni llamar al
  proveedor, porque `approve` hoy sólo marca `processing`).
- **Estado**: abierto — el alcance de LOC-115 cierra el reembolso sobre pagos `refunded`, el `pending`
  repetido y el monto superior al pago; lo cierra exigir `payments.status = 'completed'` y bloquear o
  sumar reembolsos en `processing`/`completed` cuando `approve` ejecute la devolución.

## Dos avisos de Dropi sin `eventId` e idénticos colisionan, y el `down` falla con claves repetidas (LOC-118)

- **Dónde**: `src/provider/dropi/dropi.provider.ts:189-199` (`webhookEventId`);
  `src/webhook/entities/webhookEvent.entity.ts:12` (`UQ_webhook_events_provider_event`).
- **Qué lo dispara**: (a) Dropi envía dos notificaciones distintas sin `eventId` cuyo cuerpo firmado
  (`rawBody`) es idéntico byte a byte (mismo `event`, `chargeId` y resto de campos, sin marca temporal);
  (b) correr `migration:revert` de `migrations/1793775625851-WebhookEventsUniquePerProvider.ts` cuando dos
  proveedores distintos ya guardaron filas con la misma `providerEventId`.
- **Qué rompe**: en (a), la segunda notificación se lee como duplicado de la primera; para un mismo
  `chargeId` y `event` el efecto ya es idempotente. En (b), `ADD CONSTRAINT "UQ_webhook_events_provider_id"
  UNIQUE ("providerEventId")` falla sin borrar filas para no perder historial de eventos.
- **Estado**: aceptado en LOC-118 — cuando Dropi incluye `eventId` se usa ese valor; sin `eventId`, el
  hash SHA-256 de `rawBody` es la única señal determinística cubierta por `x-dropi-signature`.


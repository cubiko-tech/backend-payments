# Riesgos de backend-payments

Una entrada por riesgo, corta (R33). El archivo nace con el primer riesgo y se borra la entrada
cuando se cierra y ya no hay código que la sostenga: la historia queda en el commit.

## Un país sin fila de precio propia pasa a cobrarse en dólares en vez de ser rechazado

- **Dónde**: `src/client/client-roles.service.ts:170` (la caída a `findUsdRow`)
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

- **Dónde**: `src/checkout/checkout.service.ts:476-483` y `:502-511` (`completeExternalPayment`)
- **Qué lo dispara**: una recarga (`purpose: wallet_recharge`) en un país con impuesto no incluido en el
  precio (CO 19%, MX 16%) cuando el proveedor confirma el pago.
- **Qué rompe**: si se acreditara `totalAmount` en vez de `subtotal`, la marca recibiría el IVA como
  saldo gastable mientras la factura declara subtotal e impuesto por separado.
- **Estado**: mitigado (criterio C1, release 002) — `completeExternalPayment` calcula
  `subtotal = totalAmount - taxAmount` antes de acreditar y llama a
  `walletService.credit(payment.walletId, subtotal, …)` con llave `payment:${payment.id}:credit`
  (`src/checkout/checkout.service.ts:483`, `:503-510`).

## Completar un pago externo puede acreditar dos veces (C2)

- **Dónde**: `src/checkout/checkout.service.ts:457-465` (`completeExternalPayment`, invocado también
  desde `reconcilePayment` en `:592-595`)
- **Qué lo dispara**: el webhook del proveedor y `POST /v1/checkout/:id/reconcile` (o dos entregas del
  mismo webhook) corriendo a la vez sobre un pago que sigue en `pending`.
- **Qué rompe**: sin reclamo atómico del estado, las dos ejecuciones pasarían el chequeo de `COMPLETED`
  y ejecutarían dos veces el crédito de wallet, la suscripción y la factura.
- **Estado**: mitigado (criterio C2, release 002) — `completeExternalPayment` reclama el pago con
  `paymentRepo.update({ id: paymentId, status: Not(PaymentStatus.COMPLETED) }, …)` y retorna si
  `claimed.affected` es 0 (`src/checkout/checkout.service.ts:457-465`).

## El cobro y el crédito de wallet no tienen llave de idempotencia (C2)

- **Dónde**: `src/wallet/wallet.service.ts:98-170` (`credit`) y `:182-295` (`debit`); columna
  `idempotencyKey` en `src/transaction/entities/transaction.entity.ts:33`
- **Qué lo dispara**: un reintento del mismo cobro o crédito con la misma `idempotencyKey`.
- **Qué rompe**: sin restricción única en base de datos, un reintento volvería a sumar o restar el saldo
  y dejaría dos filas en `transactions` para el mismo hecho.
- **Estado**: mitigado (criterio C2, release 002) — `transactions.idempotencyKey` tiene índice
  `unique: true` (`src/transaction/entities/transaction.entity.ts:33`) y tanto `credit`
  (`src/wallet/wallet.service.ts:160-163`) como `debit` (`:247-253`, `:285-288`) devuelven el movimiento
  existente sin volver a tocar el saldo.

## Un pago de servicio puede debitar una wallet de otra moneda o de tokens (C3)

- **Dónde**: `src/checkout/checkout.service.ts:193-195`, `:283-296` y `:895-930`
  (`assertWalletCurrency`)
- **Qué lo dispara**: un `POST /v1/checkout` con `provider: 'wallet'` y `purpose: 'service_payment'`
  (o `wallet_recharge`) cuya `currency` no coincide con la de la wallet, o cualquier checkout que apunte
  a una wallet en `TKN`.
- **Qué rompe**: cuando la guarda sólo corría en `plan_purchase`, un `service_payment` en USD podía
  debitar 50 unidades de una wallet en COP y emitir factura en USD, o intentar cobrar contra una wallet
  de tokens (`TKN`).
- **Estado**: mitigado en checkout (criterio C3, LOC-4) — `processCheckout` ejecuta
  `assertWalletCurrency` en todo cobro con wallet (`src/checkout/checkout.service.ts:193-195`), rechaza
  con 422 `WALLET_CURRENCY_MISMATCH` cualquier wallet `TKN` o moneda distinta (`:914-929`), y
  `processWalletPayment` pasa siempre `currency` como cuarto argumento a `walletService.debit` (`:295`).

## `WalletService.debit` no exige `walletId` ni pertenencia de la wallet a la marca (C3)

- **Dónde**: `src/wallet/wallet.service.ts:182-206` (`debit`)
- **Qué lo dispara**: una llamada directa a `walletService.debit` (por ejemplo desde `renewFromWallet` en
  `src/tasks/tasks.service.ts:1090` o desde un consumidor interno) con `walletId` vacío/`undefined`, con
  una wallet de otra `brandId` o con una wallet en `TKN`.
- **Qué rompe**: TypeORM ignora condiciones `undefined` en `findOne({ where: { id: walletId } })` y
  bloquea la primera wallet de la tabla; además, `debit` no comprueba que `wallet.brandId` coincida con
  la marca del movimiento ni rechaza wallets `TKN` por sí mismo.
- **Estado**: abierto (criterio C3, lo cierra LOC-5).

## La renovación por wallet pide precio fijo en COP, omite la moneda en `debit` y `processWalletPayment` oculta fallos del débito (C3)

- **Dónde**: `src/tasks/tasks.service.ts:1074-1097` (`renewFromWallet`) y
  `src/checkout/checkout.service.ts:283-319` (`processWalletPayment`)
- **Qué lo dispara**: el cron de renovación cobrando por wallet una suscripción cuya marca tiene precio
  en otra moneda (por ejemplo USD), o un fallo no-`RequestException` devuelto como `{ error }` por
  `walletService.debit`.
- **Qué rompe**: `renewFromWallet` consulta `getPlanPrice(sub.planSlug, 'COP')`
  (`src/tasks/tasks.service.ts:1075`) y llama a `walletService.debit` sin `expectedCurrency`
  (`:1090-1097`), debitando pesos sobre una wallet en dólares o al revés; además, en
  `processWalletPayment` (`src/checkout/checkout.service.ts:283-319`) no se inspecciona `result.error` y
  el `catch` (`:297-319`) reetiqueta cualquier excepción como `INSUFFICIENT_BALANCE`.
- **Estado**: abierto (criterio C3, lo cierra LOC-6).


<!-- R12: revisado 2026-11-06 — un solo dominio (riesgos abiertos del servicio), una entrada por título -->
# Riesgos de backend-payments

Una entrada por riesgo, corta (R33). El archivo nace con el primer riesgo y se borra la entrada
cuando se cierra y ya no hay código que la sostenga: la historia queda en el commit.

## Un país sin fila de precio propia pasa a cobrarse en dólares en vez de ser rechazado

- **Dónde**: `src/client/client-roles.service.ts:173` (`findUsdRow`)
- **Qué lo dispara**: un alta o un checkout de una marca cuyo país no tiene fila en `plan_prices`, para un
  plan con fila en dólares; incluye el checkout general de `starter`, `pro` y `enterprise`.
- **Qué rompe**: un país donde no se decidió vender cobra en dólares en vez de rechazar con
  `PRICE_NOT_FOUND_FOR_COUNTRY`. Monto y moneda salen de la misma fila: no cobra pesos como dólares.
- **Estado**: mitigado por el alcance: sólo cae a una fila en dólares que el catálogo declara. Abierto en lo
  comercial: no vender en un país se expresa quitando la fila en dólares del plan.

## Una suscripción de wallet sin `walletId` conserva el plan sin cobrar

- **Dónde**: `src/tasks/subscription-renewal.ts:117`, `:176` (`processSubscriptionRenewals`)
- **Qué lo dispara**: una fila `provider = 'wallet'`, `autoRenew`, vencida y con `walletId` nulo.
- **Qué rompe**: la marca sigue con su plan pago sin que se le cobre, mientras nadie le ponga wallet.
- **Estado**: abierto — lo cierra corregir cada fila; el log de error con su id y el contador de la pasada
  la señalan. Cuántas filas hay por ambiente no se contó: se cuenta en la entrega.

## Una renovación ya debitada no se extiende mientras `backend-roles` la rechace (LOC-14)

- **Dónde**: `src/tasks/wallet-renewal.ts:53`, `:166` (`hasCycleDebit`, `renewPlanForBrand`);
  `src/tasks/renewal-debit-refund.ts:53` (`canStillExtend`)
- **Qué lo dispara**: el débito del ciclo ya se asentó y `renewPlanForBrand` devuelve `false`.
- **Qué rompe**: la fila queda con `nextBillingDate` vencida y la extensión se reintenta cada hora sin cota.
  El débito queda retenido: el barrido de huérfanos no lo devuelve mientras la fila siga viva en ese ciclo.
- **Estado**: mitigado en el doble cobro: `hasCycleDebit` no debita otra vez y el rechazo deja un log con el
  id. Abierto en la convergencia: lo cierra acotar la extensión o devolver el débito ante un rechazo fijo.

## El caché tibio de precios sirve precios vencidos sin tope cuando cae `backend-roles` (LOC-16)

- **Dónde**: `src/client/client-roles.service.ts:187`, `:94` (`getPlanRows`, `hasCachedPrices`);
  `src/tasks/wallet-renewal.ts:77` (`isPostponementGraceExceeded`)
- **Qué lo dispara**: `backend-roles` cae después de que el proceso cargó precios una vez.
- **Qué rompe**: la renovación cobra al último precio cacheado, de cualquier antigüedad, o rechaza con
  `WALLET_CURRENCY_MISMATCH` si esa moneda no estaba en el snapshot.
- **Estado**: mitigado con caché frío: se pospone hasta 24 h (`RENEWAL_POSTPONEMENT_GRACE_HOURS`) y pasa
  a `past_due`. Abierto con caché tibio: lo cierra un tope de antigüedad en `getPlanRows`.

## El servicio no arranca si `ACCESS_SERVER` o `JWT_SECRET` falta o vale `CHANGEME` (LOC-56)

- **Dónde**: `src/main.ts:12` (`requireStartupSecret`)
- **Qué lo dispara**: iniciar con uno de los dos ausente, vacío, igual a `CHANGEME` o con espacios al borde.
- **Qué rompe**: el arranque aborta antes de escuchar en el puerto 80.
- **Estado**: abierto — lo cierra verificar los dos valores en cada ambiente antes de desplegar.

## Tres bordes del reintento con `Idempotency-Key` siguen sin salida (LOC-86)

- **Dónde**: `src/checkout/checkout-idempotency.ts:199`, `:39` (`resolvePaymentStateOutcome`,
  `canRetryFailedIdempotentPayment`); `src/checkout/checkout.service.ts:439`, `:759`
  (`retryFailedIdempotentPayment`, la llamada `provider.createCheckout` en `processExternalPayment`, con la
  entrada pública `processCheckout` en `:226`); `src/provider/dropi/dropi.provider.ts:79`
- **Qué lo dispara**: un reintento con la misma llave sobre (a) un `completed` sin
  `metadata.checkoutResult` (falló después del cierre o lo completó un webhook); (b) un externo `failed`
  sin `providerPaymentId`; (c) una fila que la ruta retirada `POST /payment/checkout` (`c77a594`, LOC-93)
  escribió con importes del cliente y quedó `failed`.
- **Qué rompe**: (a) `409 IDEMPOTENT_CHECKOUT_INCOMPLETE` para siempre, con el cobro hecho; (b) otro
  `createCheckout`: en Dropi, `POST /charges` sin llave puede dejar un segundo cobro pendiente (hipótesis,
  R14: no se ejercitó contra Dropi); (c) el reintento reusa los importes guardados de esa fila.
- **Estado**: mitigado en el reintento de `failed`: exige huella, sin `providerPaymentId` ni
  `amountMismatch`, y reclama la fila por estado. Abierto en (a), (b) y (c); las filas de (c) no se contaron.

## La conciliación de pagos `wallet` deja casos sin quien los recupere (LOC-87, LOC-96)

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:336`, `:37`, `:306`
  (`refundSupersededWalletPayment`, `WALLET_FAILED_DEBIT_LOOKBACK_MS`, `isPlanAppliedByPayment`);
  `src/client/client-roles.service.ts:351` (`callRolesApi`); `src/checkout/checkout.service.ts:2223`
  (`assignPlanInRoles`, y el booleano que ignora en `:2230`); `src/checkout/wallet-payment-close.ts:88`
  (`yieldOverlappedOlderPurchase`)
- **Qué lo dispara**: (a) `walletService.credit` falla siempre al devolver un pago superado; (b) roles falla
  al asignar el plan; (c) el proceso muere entre el cierre y `assignPlanInRoles`; (d) un `failed` con
  débito pasa 30 días sin acreditarse; (e) dos compras de planes distintos se solapan y la vieja cierra
  primero; (f) un `failed` con débito cuyo plan ya se aplicó.
- **Qué rompe**: (a) la fila queda `processing` y se reintenta cada 5 minutos sin tope; (b) y (c)
  `completed` sin el plan en roles, porque `callRolesApi` absorbe el fallo y el barrido ya no lo mira;
  (d) la plata queda sin devolver; (e) la vieja respondió `completed` y después queda `refunded`; (f) no se
  acredita y deja un log de error en cada pasada hasta salir de la ventana.
- **Estado**: mitigado en la pérdida de pagos con débito y en las carreras: candado por pago y por marca,
  devolución con llave `payment:<id>:refund`, y un pago con débito no se cancela. Abierto en (a)–(f): lo
  cierran un barrido que reasigne el plan, alertas sobre (d) y (f) y avisar a quien compró en (e).

## Un cierre que sigue fallando a la hora devuelve la plata y deja a la marca sin plan (LOC-99)

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:40`, `:444` (`WALLET_CLOSE_GIVE_UP_MS`, `claimGiveUp`)
- **Qué lo dispara**: (a) el cierre de un pago debitado sigue fallando a más de 1 h de su `createdAt`,
  también en su primer intento si el barrido llega tarde; (b) además, una compra más vieja de otro plan ya
  se acreditó porque ésta era la nueva.
- **Qué rompe**: (a) la plata vuelve a la wallet y la marca no recibe el plan; (b) las dos compras quedan
  `refunded` y la marca, sin plan.
- **Estado**: abierto en los dos, sin plata perdida: lo cierra avisar a quien compró. `claimGiveUp` reclama
  la fila antes de acreditar, así que un cierre tardío no deja plan y crédito.

## Una compra externa perdedora no se puede acreditar: tope de wallets (LOC-101, LOC-104)

- **Dónde**: `src/checkout/external-payment-close.ts:227` (`resolveRefundWallet`)
- **Qué lo dispara**: la compra perdió contra una más nueva, la marca no tiene wallet `internal` en esa
  moneda y ya tiene 10 wallets.
- **Qué rompe**: la plata cobrada no vuelve: la compra queda `processing` con `lostToNewerPurchase`, sin
  plan ni crédito, y el barrido repite el log de error cada 5 minutos.
- **Estado**: abierto — fuera de alcance por decisión de quien aprueba (2026-11-02): se resuelve a mano.
  Una wallet `internal` cerrada ya no lo dispara: se reabre (LOC-104).

## Una compra desplazada se devuelve entera con hasta 15 minutos de uso (LOC-101, LOC-103)

- **Dónde**: `src/checkout/wallet-payment-close.ts:21` (`PLAN_YIELD_WINDOW_MS`);
  `src/checkout/external-payment-close.ts:80` (`displacedWithinWindow`)
- **Qué lo dispara**: otra compra cambia el plan dentro de los 15 minutos de que ésta aplicó el suyo.
- **Qué rompe**: la marca recibe el total aunque usó el plan hasta 15 minutos; pasado el tope, nada.
- **Estado**: mitigado por el tope de 15 minutos, confirmado por quien aprueba el 2026-11-02.

## Un barrido que pierde su candado termina en error aunque su trabajo haya quedado hecho (LOC-100)

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:88`, `:656` (`acquireWalletReconcileLock`, `releaseLock`,
  con el `release` sin catch en `:104-130`)
- **Qué lo dispara**: la conexión del candado del pago muere mientras el barrido trabaja.
- **Qué rompe**: la pasada lanza `Query runner already released`, que tapa su resultado. No toca la plata:
  `claimGiveUp` y el reclamo por estado del cierre siguen siendo exclusivos.
- **Estado**: abierto — lo cierra que liberar un candado muerto no lance.

## Los crons sostienen el candado de marca mientras escriben por otras conexiones y llaman por HTTP (LOC-88)

- **Dónde**: `src/checkout/wallet-payment-close.ts:56` (`lockBrandPlan`);
  `src/tasks/subscription-lock.ts:18`, `:41` (`lockAndReread`, `acquireSubscriptionLock`)
- **Qué lo dispara**: bajo el candado se llama a roles, al proveedor y a ConfioPagos. Basta un checkout o
  un webhook de la marca mientras un cron procesa su fila; para agotar el pool, tantos cierres esperando
  como conexiones (10: default de `pg-pool`, `node_modules/pg-pool/index.js:89`; `src/orm` no fija otro).
- **Qué rompe**: un cierre de esa marca espera lo que dure esa fila. Si el pool se agota, todo el servicio
  queda sin conexión hasta que venza la espera.
- **Estado**: mitigado por `lock_timeout` de 30 s en `lockBrandPlan`: quien vence falla y lo retoma un
  barrido o la pasada siguiente; una espera legítima de más de 30 s también falla. Agotar el pool no se
  ejercitó. Lo cierra del todo escribir por la conexión del candado, que pide cambiar `WalletService.debit`.

## Un débito de renovación sin extensión puede quedar sin devolver (LOC-88, LOC-105, LOC-108)

- **Dónde**: `src/tasks/renewal-debit-refund.ts:134`, `:53` (`refundOrphanRenewalDebits`,
  `canStillExtend`); `src/tasks/wallet-renewal.ts:53`, `:157` (`hasCycleDebit`, `extendSubscriptionPeriod`)
- **Qué lo dispara**: el cron debita, la fila no se extiende y antes de la pasada siguiente un checkout,
  una extensión de admin o una baja mueven `nextBillingDate`, de la que sale la llave del ciclo.
- **Qué rompe**: sin el barrido, dos cobros y una extensión (medido sobre Postgres real: 39.800 con precio
  19.900). Con él quedan tres bordes: (a) hipótesis: la conexión cae en un COMMIT que se aplicó, la marca
  queda `extended` con la fecha sin mover y el barrido, que lista `pending`, no la devuelve; (b) una fila
  viva sobre un ciclo ya devuelto no se cobra, no se extiende ni vence (hipótesis: una baja devuelta, un
  `ACTIVE` tardío de Confío y `reactivate`); (c) una extensión de admin sobre un débito `pending` lo
  devuelve y regala los días.
- **Estado**: mitigado por `refundOrphanRenewalDebits`, que acredita el débito una sola vez. Abierto en (a)–(c).

## Una renovación que llega a roles después de la degradación deja plan pago sobre una fila cerrada (LOC-111)

- **Dónde**: `src/tasks/wallet-renewal.ts:166` (`renewPlanForBrand`);
  `src/tasks/subscription-expiration.ts:302` (`degradeInRoles`)
- **Qué lo dispara**: una baja durante la espera a roles y el barrido de acceso, que no toma el candado de
  plan, cierra la fila antes de que la extensión escriba; roles aplica la renovación después.
- **Qué rompe**: la marca conserva el plan pago en roles con la fila `cancelled`. El débito queda pendiente
  y el barrido de huérfanos lo devuelve una vez.
- **Estado**: abierto — lo cierra que el barrido de acceso tome el candado, o degradar al abortar.

## Un guardado de renovación que falla siempre cuesta el plan a quien ya pagó (LOC-108)

- **Dónde**: `src/tasks/wallet-renewal.ts:157` (`extendSubscriptionPeriod`);
  `src/tasks/subscription-renewal.ts:132` (`handleRenewalFailure`)
- **Qué lo dispara**: falla cada guardado de la extensión y no el de `handleRenewalFailure`; la pasada
  horaria no mira el backoff.
- **Qué rompe**: en unas tres horas se agotan los reintentos: avisos de pago fallido y la fila vencida.
- **Estado**: aceptado (E8): el cobro se devuelve una vez al cerrar, nunca hay dos. Abierto — lo cierra
  respetar el backoff en esa pasada, si hiciera falta.

## Una renovación cobrada y extendida puede quedar sin su fila en el historial (LOC-108)

- **Dónde**: `src/tasks/wallet-renewal.ts:125-142` (`SubscriptionEventType.RENEWED`)
- **Qué lo dispara**: falla el guardado del evento `RENEWED` con la extensión ya confirmada.
- **Qué rompe**: el historial no muestra la renovación; queda sólo el log de error con su id.
- **Estado**: mitigado por ese log, que se prefiere a un pago fallido que cobraría dos veces. Abierto — no
  hay reintento del evento.

## Un aviso de Mercado Pago con `ts` a más de 5 minutos se rechaza con 401 (LOC-113)

- **Dónde**: `src/provider/mercadopago/mercadopago.provider.ts:318`, `:355` (`SIGNATURE_WINDOW_MS`, `tsToMs`)
- **Qué lo dispara**: un reintento de Mercado Pago (cada 15 min, según su doc) que conserve el `ts`
  original; la doc no dice si lo conserva.
- **Qué rompe**: el aviso no entra. El pago lo cierra el barrido `reconcileExternalPayments`, cada 5 min.
- **Estado**: mitigado por el barrido; abierto — lo cierra ver el primer reintento real de Mercado Pago.

## Mercado Pago sin pago encontrado no distingue «no pagó» de «no lo encuentro» (LOC-89)

- **Dónde**: `src/provider/mercadopago/mercadopago.provider.ts:146` (`getPaymentStatus`);
  `src/webhook/mercadopago-payment-notice.ts:29` (`resolveMercadoPagoNotice`)
- **Qué lo dispara**: `payments/search` por `external_reference` devuelve una lista vacía: un pago anterior
  a LOC-89, con referencia `marca:propósito:ts`, o una respuesta real distinta de la del falso.
- **Qué rompe**: el barrido no hace nada y la expiración lo vence a las 24 h: un pago cobrado queda
  `failed`. El aviso tampoco lo rescata: ignora una referencia que no es un UUID.
- **Estado**: abierto — lo cierra probar la búsqueda contra una cuenta de prueba.

## Un pago sin respuesta del proveedor se pregunta en cada pasada y no expira (LOC-89)

- **Dónde**: `src/tasks/payment-sweep.ts:53`, `:340` (`reconcileExternalPayments`, `providerLetsExpire`)
- **Qué lo dispara**: un proveedor caído, sin configurar o sin registrar, con filas `pending` o `processing`.
- **Qué rompe**: las filas avisan en cada pasada; en serie, a 15–30 s por fila, una caída larga solapa la
  pasada con la siguiente. La plata no se toca: el solape lo cubren los reclamos por estado y el candado.
- **Estado**: abierto — lo cierra un corte por proveedor dentro de la pasada, si una caída real lo pide.

## Un 404 de un proveedor mal apuntado vence sus pagos (LOC-89)

- **Dónde**: `src/provider/confio/confio.provider.ts:132`; `src/provider/stripe/stripe.provider.ts:86`
  (`ProviderPaymentNotFoundError`)
- **Qué lo dispara**: una configuración de Confío o Stripe que apunte a otro lado: el 404 se lee como «el
  pago no existe».
- **Qué rompe**: los `pending` de ese proveedor expiran a las 24 h aunque estén cobrados.
- **Estado**: abierto — lo cierra comprobar la configuración de cada uno, por ambiente, contra su API.

## Mientras Dropi responda 404, sus `pending` no vencen y se acumulan (LOC-102)

- **Dónde**: `src/provider/dropi/dropi.provider.ts:49` (`dropiFetch`); `src/tasks/payment-sweep.ts:340`
  (`providerLetsExpire`); `src/admin/admin.controller.ts:297` (`paymentsPending`, con la ruta en `:294`)
- **Qué lo dispara**: Dropi responde 404 a `/charges/:id` por una ruta que no existe o por un cobro que no
  existe: no se distinguen. Se midió contra el core-back local; la API real no se conoce.
- **Qué rompe**: un `pending` abandonado no vence, sin tope, hasta que el usuario lo cancela: una llamada y
  un log `error` cada 5 minutos por fila. `GET admin/payments/pending` muestra sólo los 100 más nuevos.
- **Estado**: abierto — lo cierra confirmar la ruta real con el dueño de Dropi.

## Lo que el barrido no rescata o completa sin mirar (LOC-89)

- **Dónde**: `src/tasks/payment-sweep.ts:234`, `:114` (`expirePendingCheckouts`,
  `settleLostExternalPayments`); `src/checkout/checkout.service.ts:2117` (`assertProviderConfirmedAmount`)
- **Qué lo dispara**: (a) se paga justo después de que la expiración leyó `pending` y el webhook se pierde;
  (b) un `pending` sin `providerPaymentId`, por una caída antes de guardarlo; (c) un `processing` con plan
  que el proveedor reembolsó; (d) un monto distinto cuando el pago ya dio plan, crédito o factura; (e) otra
  instancia trae un monto distinto mientras ésta aplica el plan.
- **Qué rompe**: (a) y (b) quedan `failed`, que el barrido no mira; (c) se completa igual; (d) se completa
  con lo dado y un log de error; (e) queda `failed` con el plan puesto.
- **Estado**: abierto — (d) y (e) se ven por el log `PROVIDER_AMOUNT_MISMATCH`; el resto lo cierra una
  conciliación de `failed`.

## Un proveedor que no confirma el monto deja el pago esperando o lo completa sin verificarlo (LOC-117, LOC-127)

- **Dónde**: `src/checkout/checkout.service.ts:2117`, `:2112` (`assertProviderConfirmedAmount`,
  `isProviderNoticePayload`); `src/provider/mercadopago/mercadopago.provider.ts:173` (`transactionAmount`)
- **Qué lo dispara**: (a) un aviso sin monto confirmado (el one-shot de Confío sin `amountCents`, Mercado
  Pago con `transaction_amount` nulo); (b) después, el retorno o el barrido tampoco traen monto.
- **Qué rompe**: (a) el aviso no completa y el pago queda `pending`: si el barrido no lo encuentra, vence a
  las 24 h como `failed` aunque esté cobrado; (b) se completa sin comprobar el monto, porque fuera de un
  aviso la ausencia cuenta como confirmada.
- **Estado**: abierto — lo cierra tratar la ausencia como «no confirmado» también fuera del aviso, que el
  one-shot de Confío firme `amountCents` y resolver la búsqueda de Mercado Pago (LOC-89).

## El precio viejo todavía se puede pagar pasadas las 24 h (LOC-98)

- **Dónde**: `src/checkout/checkout.service.ts:759`, `:451` (`createCheckout`, `firstAttemptAt`);
  `src/checkout/checkout-idempotency.ts:238` (`checkoutResult`)
- **Qué lo dispara**: (a) un reintento aceptado en plazo abre una sesión cuya vida pone el proveedor; (b) un
  `pending` que el barrido no vence sigue repitiendo su `checkoutUrl` con la misma llave.
- **Qué rompe**: la compra se completa al monto guardado después de las 24 h. El tope es hipótesis: depende
  de cada proveedor y no se comprobó; `expiresAt` sólo se escribe. Ninguno crea un cobro nuevo.
- **Estado**: abierto — lo cierra pasarle el vencimiento a cada proveedor, si quien aprueba lo pide.

## Un pago con débito se cierra pasadas las 24 h si se reintenta (LOC-98)

- **Dónde**: `src/checkout/checkout.service.ts:424` (`assertRetryAllowed`)
- **Qué lo dispara**: un `failed` de wallet con débito sin acreditar que se reintenta antes del barrido.
- **Qué rompe**: la compra cierra al precio ya cobrado, sin segundo débito, en vez de responder vencido.
- **Estado**: mitigado por la exención: pedirle un pedido nuevo a quien ya pagó lo haría pagar dos veces.

## Con el claim `brand` del token se escribe en la suscripción sin consultar a platform y con cualquier rol (LOC-94)

- **Dónde**: `src/subscription/subscription.controller.ts:320`, `:335` (`resolveBrandId`, `sessionBrand`);
  `src/client/client-platform.service.ts:5` (`ALLOWED_BRAND_ROLES`);
  `src/shared/auth/api-auth.guard.ts:123`, `:173` (`payload.brand`, `decodeClaims`, que se usa en `:165`)
- **Qué lo dispara**: `POST /subscription/trial`, `/paid`, `/cancel` o `/reactivate` con un token que trae
  `brand`, con esa marca en el cuerpo o sin ninguna.
- **Qué rompe**: la escritura no mira membresía ni rol, mientras otra marca nombrada exige `superuser`,
  `admin` o `financial`: un miembro de otro rol cancela la suscripción. Hipótesis: quien salió de la marca
  sigue escribiendo mientras viva su token (otro repositorio, no se abrió).
- **Estado**: abierto — lo cierra que quien aprueba decida si el claim basta; si no, `resolveBrandId`
  consulta `canViewBrandCredit` también con la marca de la sesión.

## Una fila wallet sin `nextBillingDate` no se cobra y ningún barrido la saca (LOC-91)

- **Dónde**: `src/tasks/wallet-renewal.ts:46` (`renewFromWallet`); `src/tasks/subscription-renewal.ts:92`,
  `:155` (`processSubscriptionRenewals`, `retryFailedPayments`); `src/tasks/subscription-expiration.ts:88`
  (`expireSubscriptions`); `src/subscription/dto/create-subscription.dto.ts:78` (`nextBillingDate`)
- **Qué lo dispara**: una fila wallet con `autoRenew` y sin fecha, de `POST /subscription` sin el campo o
  de una corrección a mano; entre ellas, las que ya pagaron antes de LOC-91 con llave `…:current`.
- **Qué rompe**: la fila no paga ni vence. En `past_due` deja un log por reintento; en `active`, nada. Con
  plan en roles es servicio sin cobrar (hipótesis: no se abrió roles). Darle fecha la cobra dos veces: la
  llave cambia (medido sobre Postgres real: saldo esperado 200000, final 150000).
- **Estado**: abierto — lo cierra decidir qué se hace con esas filas y exigir la fecha en el alta. Antes de
  darle fecha se busca su llave `…:current`; `retryFailedPayments` no mira la fecha.

## Una nota crédito sin CUFE no se reenvía sola, y el reenvío manual no comprueba el orden (LOC-106)

- **Dónde**: `src/checkout/refund-credit-note.ts:109` (`sendToDian`); `src/dian/dian.controller.ts:26` (`sendInvoice`)
- **Qué lo dispara**: la DIAN rechaza la factura o la nota, o el proceso muere tras crear la nota.
- **Qué rompe**: la plata ya volvió y el documento fiscal no llega: queda `metadata.dianPending` y, salvo
  en la caída, `credit_note_dian_failed` en `audit_log`. Reenviar la nota antes que su factura la manda
  sobre un documento que la DIAN no conoce.
- **Estado**: abierto — no se reintenta a propósito: una respuesta perdida duplicaría el documento. Lo
  cierra un envío idempotente ante Siigo.

## Un proceso que muere enviando a la DIAN deja el documento reclamado (LOC-106)

- **Dónde**: `src/dian/dian.service.ts:191` (`claimSend`); `src/dian/dian.controller.ts:28` (`reclaimStale`)
- **Qué lo dispara**: el proceso muere con `metadata.dianSendingAt` puesto.
- **Qué rompe**: el documento queda sin CUFE y sin envío automático; pasados cinco minutos sólo lo retoma el
  envío manual, que lo duplica si la DIAN sí lo había recibido.
- **Estado**: abierto — lo cierra un envío idempotente ante Siigo; antes de reenviar se mira en Siigo.

## El PDF de una nota crédito muestra el UUID de la factura, no su número (LOC-106)

- **Dónde**: `src/invoice/invoice-pdf.service.ts:149` (`creditNoteForId`)
- **Qué lo dispara**: descargar el PDF de cualquier nota crédito.
- **Qué rompe**: el documento nombra la factura por un identificador interno. No afecta a la DIAN.
- **Estado**: abierto — lo cierra leer `invoiceNumber` de la factura al armar el PDF.

## El payload de Siigo referencia la factura sólo en texto (LOC-106)

- **Dónde**: `src/dian/providers/siigo.provider.ts:255-259` (`observations`)
- **Qué lo dispara**: cualquier nota crédito enviada a Siigo. Sólo se probó contra `DIAN_PROVIDER=mock`.
- **Qué rompe**: hipótesis, no comprobada: si Siigo exige una referencia estructurada, rechazaría la nota.
- **Estado**: abierto — lo cierra el contador con una prueba contra el sandbox de Siigo.

## Un número de query ausente llega como `NaN` desde que el pipe global convierte tipos (LOC-114)

- **Dónde**: `src/shared/validation/global-validation-pipe.ts:15` (`transform: true`)
- **Qué lo dispara**: un handler nuevo con `@Query('x') x?: number` que pone su default con `??`. Nest
  10.4.22 convierte con `+value` (`node_modules/@nestjs/common/pipes/validation.pipe.js:131-132`).
- **Qué rompe**: el `NaN` llega a una fecha o a un `take`: fecha inválida o listado sin tope. Los handlers
  de hoy usan `||` y caen al default.
- **Estado**: mitigado por el contrato del encabezado de la fábrica y el caso `admin-extend-body.spec.ts`;
  abierto para el handler que no lo lea.

## El retorno del checkout distingue con 503 si el `paymentId` existe cuando cae `platform` (LOC-116)

- **Dónde**: `src/checkout/checkout.service.ts:1147` (`reconcilePayment`);
  `src/checkout/checkout.controller.ts:134` (`paymentReturn`)
- **Qué lo dispara**: (a) `GET /v1/checkout/return` mientras `backend-platform` no responde; (b) un 400 o
  404 que llega al BFF de `frontend-platform` (otro repositorio, no se abrió en LOC-131).
- **Qué rompe**: (a) un `paymentId` inexistente da 404 y uno existente 503 `BRAND_LOOKUP_UNAVAILABLE`: la
  caída revela que el UUID existe; (b) el BFF responde 500 a `PaymentReturnView.jsx`.
- **Estado**: (a) aceptado (UUID v4 no adivinable) para no darle un falso 404 a la marca dueña ante un
  parpadeo de platform; (b) abierto en el consumidor (`frontend-platform`).

## La devolución a la wallet no mira los reembolsos en curso del mismo pago (LOC-127)

- **Dónde**: `src/checkout/wallet-payment-reconciliation.ts:336` (`refundSupersededWalletPayment`);
  `src/refund/refund.service.ts:114` (`createPendingRefund`)
- **Qué lo dispara**: un `POST /v1/refund` sobre un `completed` que queda `pending` o `processing`, y
  después la conciliación devuelve ese pago a la wallet.
- **Qué rompe**: dos devoluciones posibles del mismo pago; `approve` hoy sólo marca `processing`, así que
  el doble pago aparece cuando se ejecute.
- **Estado**: abierto — lo cierra leer `refunds` bajo el mismo candado y frenar una de las dos.

## Dos avisos de Dropi sin `eventId` e idénticos colisionan, y el `down` falla con claves repetidas (LOC-118)

- **Dónde**: `src/provider/dropi/dropi.provider.ts:189` (`webhookEventId`);
  `src/webhook/entities/webhookEvent.entity.ts:12` (`UQ_webhook_events_provider_event`)
- **Qué lo dispara**: (a) dos notificaciones sin `eventId` con el mismo `rawBody`; (b) `migration:revert`
  de `migrations/1793775625851-WebhookEventsUniquePerProvider.ts` con una `providerEventId` repetida
  entre proveedores.
- **Qué rompe**: (a) la segunda se lee como duplicado, con efecto ya idempotente para el mismo `chargeId`
  y `event`; (b) el `ADD CONSTRAINT` falla sin borrar filas, para no perder historial.
- **Estado**: aceptado en LOC-118: sin `eventId`, el SHA-256 de `rawBody` es la única señal determinística
  que cubre `x-dropi-signature`.

## `POST /billing-profile/:brandId/documents` exige `https://` pero no filtra el host de `documentUrl` (LOC-123)

- **Dónde**: `src/billing-profile/dto/legal-document.dto.ts:65` (`documentUrl`);
  `src/billing-profile/billing-profile.controller.ts:182` (`uploadDocument`)
- **Qué lo dispara**: un llamador con acceso a `brandId` envía una URL `https://` de un dominio externo.
- **Qué rompe**: el enlace se guarda y se le muestra como externo al operador que revisa en `admin`.
- **Estado**: abierto — se rechazan otros esquemas y textos que no son URL; la lista blanca de hosts quedó
  en INBOX (aprobado 2026-11-04).

## Un aviso firmado de Confío con `timestamp` fuera de 24 h se rechaza con 401 para siempre (LOC-117)

- **Dónde**: `src/provider/confio/confio-webhook-signature.ts:6`, `:456`
  (`CONFIO_WEBHOOK_TIMESTAMP_WINDOW_MS`); `src/webhook/webhook.controller.ts:270` (`autenticarRamoFirmado`)
- **Qué lo dispara**: un aviso firmado de suscripción que llega o se reintenta a más de 24 h de su `timestamp`.
- **Qué rompe**: 401 `timestamp_out_of_window` en cada reentrega tardía, y no hay un barrido de
  suscripciones de Confío que rescate ese cambio sin intervención manual.
- **Estado**: abierto — lo cierra confirmar los reintentos de Confío o barrer las `confio` con `getSubscription`.

## El saldo de una wallet `TKN` sin origen no se gasta (LOC-132)

- **Dónde**: `src/wallet/token-wallet.service.ts:122` (`planTokenSpend`), `:286` (`unassigned`)
- **Qué lo dispara**: una wallet `TKN` con saldo anterior a la migración `1793949572497`. Admin ya no la
  crea ni la ajusta (LOC-133: 422), y el regalo entra por `TokenWalletService` con su origen.
- **Qué rompe**: ese saldo aparece en `unassigned` y el débito de tokens no lo toma, porque decide por los
  orígenes; si admin baja el total por debajo de los orígenes, el débito rechaza por `balance`.
- **Estado**: abierto — lo cierra que quien aprueba diga a qué origen va el saldo previo.

## Una marca puede tener otra wallet `TKN` además de la `internal/TKN` (LOC-132)

- **Dónde**: `src/wallet/entities/wallet.entity.ts:18` (`@Index`, único por marca, provider y moneda)
- **Qué lo dispara**: filas `TKN` con otro `provider` o en minúsculas anteriores a LOC-132 y LOC-133
  (`POST /wallet` y `POST /admin/wallets` ya las rechazan).
- **Qué rompe**: la marca ve en `GET /wallet` una segunda wallet de tokens que `GET /token-wallet` no usa.
- **Estado**: abierto — lo cierra un índice único parcial por marca sobre `UPPER(currency) = 'TKN'`, después de
  contar si hay filas así por ambiente.

## Un regalo de tokens a un `brandId` que no es una marca crea su wallet `TKN` (LOC-133)

- **Dónde**: `src/admin/admin-token-gift.controller.ts:40` (`getOrCreate`)
- **Qué lo dispara**: un super admin que manda un UUID válido que no corresponde a ninguna marca.
- **Qué rompe**: queda una wallet `TKN` con regalo que nadie ve; los tokens no llegan a la marca buscada.
- **Estado**: abierto — lo cierra preguntarle a platform si la marca existe antes de acreditar.

## Con la fuente de la TRM caída más de una hora, el pago que la usa se rechaza

- **Dónde**: `src/trm/trm.service.ts:32` (`getUsdCopRate`), `src/checkout/token-package-checkout.ts:76` (`chargeFor`)
- **Qué lo dispara**: `datos.gov.co` sin responder, con error o con una fila ilegible, y sin una tasa consultada
  en la última hora por esa instancia. El caché es por instancia: N instancias hacen hasta N consultas por hora.
- **Qué rompe**: el checkout de un paquete de tokens de una marca colombiana responde 503
  `EXCHANGE_RATE_UNAVAILABLE` y no guarda el pago; no hay tasa de respaldo (decisión de quien aprueba, 2026-11-06).
  Es el único precio que se cobra con la TRM.
- **Estado**: abierto — aceptado por diseño; lo reabre un respaldo decidido por quien aprueba.

## Un paquete de tokens cobrado queda sin tokens si la wallet `TKN` se cierra antes del aviso (LOC-136)

- **Dónde**: `src/checkout/token-package-checkout.ts:99` (`creditTokenPackage`);
  `src/wallet/token-wallet.service.ts:90-92`
- **Qué lo dispara**: la wallet `TKN` de la marca pasa a `closed` entre el checkout del paquete y la confirmación
  del proveedor.
- **Qué rompe**: el pago queda `processing`, cobrado, sin tokens y sin factura; el barrido lo reintenta y vuelve a
  fallar con `WALLET_CLOSED`.
- **Estado**: abierto — lo cierra decidir si se reabre la wallet o se devuelve el pago. El checkout ya rechaza una
  `TKN` cerrada antes de cobrar (`token-package-checkout.ts:70-71`).

## Aprobar el reembolso de un paquete quita los tokens antes de que la plata vuelva (LOC-161)

- **Dónde**: `src/refund/refund.service.ts:230` (`approvePending`); `src/provider/provider.interface.ts:84`
  (`refundPayment`, sin llamador)
- **Qué lo dispara**: un reembolso de paquete aprobado cuya devolución, hecha fuera de Pagos, nunca se paga; o un
  reembolso hecho directo en el proveedor (`src/webhook/webhook.service.ts:184-186` sólo lo loguea).
- **Qué rompe**: en el primer caso la marca queda sin tokens y sin plata, porque ningún código pasa un reembolso a
  `completed` ni a `failed` ni devuelve los tokens; en el segundo, recupera la plata y conserva los tokens.
- **Estado**: abierto — lo cierra el flujo que complete o falle el reembolso con el proveedor y escuche sus
  reembolsos.

## Un crédito válido sobre un saldo cerca del máximo de `numeric(15,2)` responde 500 (LOC-139)

- **Dónde**: `src/wallet/wallet.service.ts:169` (`credit`); `src/wallet/token-wallet.service.ts:176` (`move`)
- **Qué lo dispara**: un saldo que ya pasa de 9 billones (1e12 × 9) recibe otro crédito dentro del tope del DTO
  (`src/admin/dto/money-input.ts`, 1e12).
- **Qué rompe**: Postgres rechaza la suma con `numeric field overflow`, el movimiento no se aplica y responde 500 en
  vez de 422.
- **Estado**: abierto — el tope del borde lo vuelve lejano; lo cierra comprobar la suma contra el máximo de la columna
  en el servicio.

## Quien tiene el `clientSecret` de un client firma el `id` y la `brand` de cualquier usuario (LOC-143)

- **Dónde**: `src/shared/auth/api-auth.guard.ts:159`, `:165` (`validateViaAuth`: `id` y `brand` salen de la respuesta
  de backend-auth, que según LOC-143 devuelve el payload firmado tal cual)
- **Qué lo dispara**: un token de auto-login firmado con el `clientSecret` (el client `dropi` lo usa Dropi) con el
  `id` de otro usuario o una `brand` ajena.
- **Qué rompe**: `@RequirePermission` consulta `checkPermission(id)` y la marca `canViewBrandCredit(id)` con ese
  `id`, así que se actúa como ese usuario. Que backend-roles le conceda permisos de admin a ese id es hipótesis
  (no se abrió). El super admin ya no: el guard lo pone en `false` para todo el camino del client (`:164`).
- **Estado**: abierto — lo cierra que backend-auth devuelva el usuario y el rol de su base, no el payload (tarea
  aparte, en ese repo).

## La línea «Webhook recibido» de Confío lleva el `data.name` del proveedor sin escapar

- **Dónde**: `src/webhook/webhook.service.ts:94`; el id, `src/provider/confio/confio-webhook.ts:65-67` y `:107`
  (`buildConfioWebhookEventId`)
- **Qué lo dispara**: un webhook de Confío autenticado cuyo `data.name` trae un salto de línea, comillas o `=`.
- **Qué rompe**: la línea de log se parte o suma pares `clave=valor` falsos (CWE-117). Sólo el log: el id sigue
  siendo la clave de idempotencia y no cambia.
- **Estado**: abierto — lo cierra pasar el id por `escapeLogValue` en esa línea (LOC-162 la dejó como estaba porque
  su aceptación pide conservarla).

## Una suscripción de Confío en `past_due` recibe links de pago del cron además de la recurrencia de Confío

- **Dónde**: `src/tasks/subscription-renewal.ts:182-184` (`retryFailedPayments` → `issueExternalCharge`); las
  entradas a `past_due`, `src/webhook/confio-subscription-webhook.service.ts:743-756` (`planearCambioDeEstado`) y
  `:455-462` (`planearCobro`)
- **Qué lo dispara**: (a) un `subscription.subscriptionStatusChanged` con `PAST_DUE` o `SUSPENDED` sobre una fila
  `pending` (el cobro fallido sobre `pending` ya no la mueve, LOC-163); (b) un cobro fallido sobre una fila viva.
- **Qué rompe**: (a) un alta que nunca se activó recibe un segundo link de pago sobre su primer período; (b) la marca
  recibe un link nuestro mientras Confío reintenta su propio cobro: dos caminos para pagar el mismo ciclo. Que
  Confío emita (a) para un alta no aceptada, y que reintente por su cuenta en (b), es hipótesis (no se midió).
- **Estado**: abierto — lo cierra decidir si el cron emite links para `provider = 'confio'` (tarea aparte).

## Una key de servicio filtrada crea e informa recargas hasta que se rote o se desactive (LOC-173)

- **Dónde**: `src/shared/auth/service-credential.service.ts:41` (`authenticate`);
  `src/shared/auth/api-auth.guard.ts:111`
- **Qué lo dispara**: la key de ROAX Ads (`psk.roax-ads.…`) sale de donde la guarda backend-ads.
- **Qué rompe**: quien la tenga entra a las rutas marcadas `@RequireServiceClient('roax-ads')` (crear e
  informar recargas, LOC-174/175); a ninguna otra, ni a `admin/*`.
- **Estado**: mitigado por la rotación y la desactivación de `admin/service-credentials`, que valen desde su
  commit. Abierto: la key no vence sola.

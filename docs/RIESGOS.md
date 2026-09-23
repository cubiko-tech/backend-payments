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

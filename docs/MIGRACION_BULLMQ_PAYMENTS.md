# Migración Bull (clásico) → BullMQ — backend-payments

Fecha: 2026-06-03 · Estado: **aplicada y verificada (typecheck OK)**

## Por qué

Bull clásico (`bull` v4 + `@nestjs/bull`) está en **maintenance mode** (solo bug fixes,
EOL-track en 2026). **BullMQ** es el sucesor activo, TS-nativo, del mismo equipo
(Taskforce.sh). Estandarizamos el org en BullMQ; este servicio era el único que usaba
Bull clásico. (El nuevo módulo de gestión de campañas Meta en `backend-processes` también
usará BullMQ — ver `backend-processes/docs/DISEÑO_GESTION_CAMPAÑAS_META.md` §7.2.)

## Alcance — uso de la cola (contenido en `webhook/`)

Una sola cola: `webhook-retry` (reintento de webhooks de pago fallidos con backoff
exponencial 1/5/30 min, dead-letter tras 3 intentos). La **fuente de verdad sigue siendo
Postgres** (`WebhookEvent`); Bull/BullMQ es solo transporte de reintento. Ese diseño no
cambió — solo la librería.

## Cambios aplicados

| Archivo | Cambio |
|---|---|
| `package.json` | `@nestjs/bull ^10.2.3` → `@nestjs/bullmq ^10.2.3`; `bull ^4.16.5` → `bullmq ^5.34.0` |
| `src/app.module.ts` | import `@nestjs/bullmq`; `BullModule.forRoot({ redis: {...} })` → `forRoot({ connection: {...} })` |
| `src/webhook/webhook.module.ts` | import `@nestjs/bullmq` (`registerQueue` igual) |
| `src/webhook/webhook.processor.ts` | **cambio de API**: `@Processor`+`@Process('retry')` → clase `extends WorkerHost` con `async process(job)`; `super()` en constructor; tipos `Job` desde `bullmq`. **Lógica idéntica** |
| `src/webhook/webhook.service.ts` | imports `InjectQueue`/`Queue` desde `@nestjs/bullmq`/`bullmq`. `queue.add(name, data, { delay, attempts, removeOnComplete })` es compatible sin cambios |
| `.npmrc` (nuevo) | `legacy-peer-deps=true` — ver nota abajo |

### Diferencias de API Bull → BullMQ que aplicaron aquí
- **No existe `@Process('named')`.** El processor extiende `WorkerHost` e implementa
  `process(job)`; si hubiera varios nombres de job se despacha por `switch (job.name)`.
- `forRoot` usa `connection` (opciones ioredis), no `redis`.
- `Queue`/`Job` se importan de `bullmq` (no `bull`).

## Nota sobre `.npmrc` (legacy-peer-deps)

`bullmq` declara `redis` (node-redis) como **peerOptional `>=5.0.0`**. La app usa
**node-redis v4** directamente (`src/event-bus/event-bus.service.ts`, `createClient`) y
**bullmq usa ioredis internamente**, así que ese peer opcional no aplica en runtime.
`legacy-peer-deps=true` evita el falso `ERESOLVE` en install (local, CI y Docker) sin
tocar la versión de `redis`. **No** se bumpeó `redis` para no arriesgar el event-bus.

## Verificación

- `npm install` ✅ (resuelve con `.npmrc`).
- `tsc --noEmit` ✅ (typecheck limpio).
- Sin referencias residuales a `@nestjs/bull`/`from 'bull'`/`@Process` en el código.
- `package-lock.json` consistente (sin `@nestjs/bull` clásico; con `bullmq` + `@nestjs/bullmq`).

## Pendiente (fuera de esta migración)

- Probar el flujo de reintento end-to-end contra Redis real (requiere Redis + DB; no se
  corrió aquí). El comportamiento del processor se preservó idéntico, incluido el `throw`
  de "pendiente de reprocesamiento" (lógica preexistente, no modificada).

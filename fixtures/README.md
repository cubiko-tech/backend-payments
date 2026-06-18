# Fixtures de backend-payments

## Estado actual

Los catálogos semilla (tax_config, provider_config, country_billing_config)
**ya están poblados vía migraciones** — no vía fixtures. La estructura aquí
está lista para futuros catálogos que no ameriten una migración.

- `1742600000000-InitialSchema.ts` → seed tax_config (IVA Colombia 19%)
- `1775500000000-AddProviderConfig.ts` → seed provider_config (CO/MX/US)
- `1775600000000-AddCountryBillingConfig.ts` → seed country_billing_config (CO/MX/US)

## Estructura

```
fixtures/
├── core/                    # Hoy vacío. Destino de nuevos catálogos.
└── environments/
    ├── dev/                 # Datos fake (hoy vacío)
    └── prod/                # Reservado (hoy vacío)
```

`entrypoint.sh` llama a `npm run fixtures:core || true` — con `core/` vacío es un
no-op seguro. Al agregar YAMLs aquí (con `id:` UUID fijo) se cargarán
automáticamente en todos los ambientes.

## Cómo agregar un nuevo catálogo

**Para datos que van a evolucionar** (ej. agregar más países, más proveedores):
preferir fixtures. Crear `core/NN-nombre.yml` con items que tengan `id:` UUID
fijo. La próxima corrida los upserta.

**Para datos estructurales iniciales** (ej. primer país al crear la tabla):
preferir seed embebido en la migración (como se hizo hoy). Es atómico con el
cambio de schema y no requiere paso extra.

## UUIDs reservados (cuando se usen)

- `e0000001-...` tax_config
- `e0000002-...` provider_config
- `e0000003-...` country_billing_config
- (incrementar para nuevos catálogos)

## Migrar seeds de migración a fixtures (si se decide a futuro)

Los seeds actuales en migraciones generaron UUIDs aleatorios con
`uuid_generate_v4()`. Para migrar a fixtures sin duplicar:

```sql
-- Ejemplo: alinear tax_config CO al UUID de fixture
UPDATE tax_config SET id = 'e0000001-0000-4000-8000-000000000001' WHERE country = 'CO';
```

Luego crear el YAML correspondiente con ese UUID y mover el INSERT fuera de la
migración. Este paso es opcional; mientras los seeds sigan en migración
funcionarán igual.

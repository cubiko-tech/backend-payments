# Instrucciones de `backend-payments`

El mapa de módulos de `src/`, enlaces a [`docs/RIESGOS.md`](docs/RIESGOS.md) y comandos del servicio
viven en [`CLAUDE.md`](./CLAUDE.md). Leé [`CLAUDE.md`](./CLAUDE.md) antes de modificar este repositorio.

## Comprobación de carga en `agy` 1.4

- **Qué archivo lee `agy` 1.4**: carga automáticamente `AGENTS.md` al recorrer desde el directorio de
  trabajo hasta la raíz del repositorio; no carga `CLAUDE.md` de forma directa.
- **Con qué se comprobó**: en `agy --version` (1.4.4), verificando el bloque `<user_rules>` inyectado al
  iniciar sesión en el workspace (que carga `AGENTS.md` pero omite `CLAUDE.md`) y la especificación
  integrada de `agy-customizations` (sección *Directory-Based Rules*).

@[CLAUDE.md](./CLAUDE.md)

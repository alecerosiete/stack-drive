# AGENTS.md — StackDrive

Guía de orientación para agentes de IA (y humanos) que trabajen en este
repositorio. El contexto de negocio y las decisiones de diseño detalladas
están en `README.md`; este archivo es el mapa rápido: qué hay, cómo se
ejecuta y qué convenciones seguir para que un cambio encaje sin fricción.

## Qué es esto

StackDrive es un backend multi-tenant que centraliza **N cuentas de Google
Drive por usuario** bajo una sola API, sin almacenar un solo byte de archivo
en servidores propios: todo vive en la cuota gratuita de las cuentas de
Google que cada usuario vincula. Incluye un panel web (`frontend/`) para
ejercitar el flujo completo sin herramientas externas.

## Stack

| Capa | Elección | Por qué |
|---|---|---|
| Lenguaje | TypeScript 5, `strict: true` | Tipado estricto en todo `src/`; sin `any` implícito. |
| Framework | NestJS 11 | Módulos por dominio + DI nativa, encaja con la separación auth/google/accounts/drive/jobs que exige el negocio. |
| Base de datos | PostgreSQL vía Prisma 6 | Migraciones versionadas en SQL plano (`prisma/migrations/`), no solo `db push`. |
| Cola de trabajos | Redis + BullMQ (`@nestjs/bullmq` **11.0.5**, no 12+) | Transferencias entre cuentas asíncronas con reintentos y progreso. **Fijar la v11**: la v12 es ESM puro y rompe en Node < 22.12. |
| Google | `googleapis` + `google-auth-library` | Cliente oficial; un `OAuth2Client` por operación, nunca reutilizado entre cuentas. |
| Validación | `class-validator` / `class-transformer` | Todo DTO de entrada se valida; `ValidationPipe` global con `whitelist: true`. |
| Auth de plataforma | JWT propio (`@nestjs/jwt`) + sesiones opacas revocables | Independiente de las credenciales de Google. |
| Cifrado | AES-256-GCM nativo (`node:crypto`), sin librería externa | Cifra los `refresh_token` antes de tocar la base de datos. |
| Panel web | React 19 + Vite + Tailwind 4 + TanStack Query (`frontend/`) | Paquete npm independiente, con su propio `package.json`; habla con la API solo por HTTP (`VITE_API_URL`). |
| Tests | Jest + `ts-jest` | Unitarios con dobles de `googleapis`/Prisma; sin tests contra la API real de Google. |

## Arrancar el entorno

```bash
cp .env.example .env            # y rellena GOOGLE_CLIENT_ID/SECRET + npm run keygen (x2)
docker compose up -d            # PostgreSQL + Redis
npm install
npx prisma migrate deploy
npm run start:dev               # API en :3000
cd frontend && npm install && npm run dev   # panel en :5173 (otra terminal)
```

Sin `.env` válido, `loadConfiguration()` lanza al arrancar — es intencional,
no un bug: la app se niega a escuchar con configuración a medias (ver
`src/config/configuration.ts`).

## Mapa del código

```
src/
  config/      Validación de entorno (configuration.ts) + módulo global (config.module.ts).
               TODA variable de entorno se lee aquí, nunca con process.env disperso.
  crypto/      Sobre AES-256-GCM de los refresh_token (token-crypto.service.ts).
  prisma/      PrismaService como único punto de acceso a la base de datos.
  auth/        Identidad de la plataforma: JWT, registro/login, sesiones revocables.
  google/      Vinculación OAuth, Token Refresh Engine, factoría de clientes de Drive.
               Es el ÚNICO lugar que descifra refresh_token o habla con el
               endpoint de OAuth de Google.
  accounts/    CRUD del inventario de cuentas vinculadas de un tenant.
  drive/       Servicios de Drive v3: por cuenta (drive.service.ts) y
               agregados multi-cuenta (drive-aggregate.service.ts).
  jobs/        Cola BullMQ: transferencias entre cuentas y vigía de cuota.
  common/      Guards, decorators, filtro de excepciones, utilidades de
               reintento y de interpretación de errores de Google.
prisma/schema.prisma   Fuente de verdad del modelo de datos.
test/app-wiring.spec.ts   Verifica que TODO el grafo de DI resuelve al
                          arrancar — es la red de seguridad contra un
                          provider mal scoped (ver nota de abajo).
frontend/      Panel web (React + Vite): src/api (cliente y hooks), src/features/<dominio>.
```

## Invariantes que no se deben romper

Estas no son preferencias de estilo: romperlas reintroduce justo los bugs que
ya se encontraron y corrigieron al construir el proyecto.

1. **Ningún `refresh_token` se guarda ni se loguea en claro.** Pasa siempre
   por `TokenCryptoService.seal()` antes de tocar la base de datos. El AAD es
   `userId:googleUserId` (`contextFor()` en `google-token.service.ts`): no lo
   cambies sin migrar los sobres ya cifrados, o deja de poder descifrarlos.

2. **`GoogleTokenService` es el único que refresca tokens.** Ningún otro
   servicio debe instanciar un `OAuth2Client` con un `refresh_token` propio.
   Si necesitas un cliente de Drive autorizado, pide uno a
   `DriveClientFactory`.

3. **Providers globales van en un `@Global()` module, no en `AppModule`.**
   `APP_CONFIG` vivió en `AppModule` en una versión temprana y rompía el
   arranque en cuanto otro módulo lo inyectaba (los providers de Nest son
   locales a su módulo). Por eso existe `config.module.ts` y por eso existe
   `test/app-wiring.spec.ts`: si añades un provider que debe ser transversal,
   verifica que ese test siga en verde.

4. **Las operaciones multi-cuenta son tolerantes a fallos parciales.**
   Cualquier fan-out sobre `N` cuentas usa `Promise.allSettled`, nunca
   `Promise.all`: una cuenta en `NEEDS_REAUTH` no debe tumbar la respuesta
   agregada de las otras `N-1`.

5. **La redistribución por cuota nunca mueve nada por sí sola.**
   `GET /drive/rebalance/plan` propone; solo `POST /drive/transfers`
   (siempre a petición explícita del usuario) ejecuta. No añadas un cron que
   dispare movimientos automáticamente sin que el usuario los confirme antes.

6. **Transferencia entre cuentas = copiar, verificar, luego (quizá) borrar.**
   El original se envía a la papelera solo después de comparar md5 o tamaño
   de la copia, nunca antes. Los documentos nativos de Google (Docs/Sheets/
   Slides) se pueden copiar pero no se pueden mover: la copia es una
   conversión de formato, no un duplicado verificable.

7. **Subidas y descargas son streaming de extremo a extremo.** No
   bufferices un archivo completo en memoria ni lo escribas a disco en
   ningún punto del camino cliente → Google ni Google → cliente.

8. **Fija versiones de paquetes que cambian de formato de módulo entre
   majors.** `@nestjs/bullmq` pasó a ESM puro en la v12; por eso el
   `package.json` fija `11.0.5`. Antes de subir una dependencia de major,
   comprueba `"type"` en su `package.json` y que `require()` la cargue en
   Node, no solo que compile.

## Convenciones de código

- Cada módulo de negocio sigue el patrón `*.module.ts` / `*.controller.ts` /
  `*.service.ts` / `dto/*.dto.ts`. Los tipos de vista pública (lo que
  realmente sale por la API) viven en `*.types.ts`, separados de los modelos
  de Prisma, para que un cambio en el esquema no filtre campos sensibles
  (sobre todo en `google/` y `drive/`, done esto es crítico).
- Comentarios en español, explicando el **por qué** de una decisión no
  obvia (igual que los que ya hay en el código), no el qué — el código ya
  dice el qué.
- Los errores de dominio son excepciones HTTP tipadas en
  `src/common/errors.ts`, con un `code` estable (`ErrorCode`) para que el
  cliente pueda ramificar sin parsear el mensaje.
- Los errores de Google se normalizan siempre con
  `normalizeGoogleError()`/`isInvalidGrant()`/`isRetryableGoogleError()`
  (`src/common/google-error.util.ts`) antes de decidir nada; no inspecciones
  la forma de `GaxiosError` a mano en otro sitio.
- Todo DTO de entrada usa decoradores de `class-validator`; no se valida "a
  mano" dentro de un controller o servicio.

## Pruebas

```bash
npm test          # suite completa (Jest)
npm run lint      # tsc --noEmit
npm run build     # nest build
cd frontend && npm run build   # tsc -b + vite build del panel
```

Antes de dar un cambio por terminado en `google/`, `crypto/` o `jobs/`,
corre `npm test` — ahí viven las pruebas que fijan el comportamiento del
cifrado, el motor de refresco y el plan de redistribución. Un cambio en
`AppModule` o en cualquier provider `@Global` debe mantener en verde
`test/app-wiring.spec.ts`.

No hay Docker/PostgreSQL/Redis garantizados en el entorno del agente: los
tests unitarios usan dobles y no requieren infraestructura levantada. Si
necesitas probar contra servicios reales, `docker compose up -d` primero.

## Lo que NO hay (todavía)

Ver "Límites conocidos" en `README.md` — *resumable upload*, histórico de
cuota (solo última foto) y desglose separado de Gmail y Fotos. No asumas que
existen al planificar un cambio relacionado.

Las transferencias de carpetas completas y de varios elementos viven en
`drive/batch-transfer.service.ts` (job `batch` de la cola). Cada archivo pasa
por `DriveAggregateService.transfer`, así que hereda la verificación antes de
borrar; no dupliques esa lógica en el lote.

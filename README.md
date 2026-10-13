# StackDrive API

Backend multi-tenant que unifica **N cuentas de Google Drive por usuario** bajo
un único panel. La plataforma no almacena archivos: delega el almacenamiento en
las cuotas de las cuentas de Google que cada cliente vincula, y hace de capa de
orquestación (credenciales, listados, subidas, movimientos y vista agregada).

- **Stack:** NestJS 11 · TypeScript · PostgreSQL (Prisma) · Redis (BullMQ) · `googleapis`
- **Scope de Google:** `https://www.googleapis.com/auth/drive` (control total)
- **Autenticación de plataforma:** JWT propio (email + contraseña), independiente de Google

---

## 1. Arquitectura

```
┌──────────────┐
│  frontend/   │  Authorization: Bearer <JWT de StackDrive>
│  (panel web) │
└──────┬───────┘
       │
┌──────▼─────────────────────────────────────────────────────────────┐
│ StackDrive API (NestJS)                                            │
│                                                                    │
│  auth/      Identidad del tenant (JWT + sesiones revocables)       │
│  google/    Vinculación OAuth · Token Refresh Engine · factoría    │
│             de clientes de Drive autorizados                       │
│  accounts/  Inventario de cuentas vinculadas del tenant            │
│  drive/     Servicios de Drive v3 (una cuenta) + agregados (N)     │
│  jobs/      Cola de transferencias entre cuentas · vigía de cuota  │
│  crypto/    Sobre AES-256-GCM de los refresh_token                 │
└──────┬──────────────────────┬──────────────────────────────────────┘
       │                      │
┌──────▼──────┐        ┌──────▼──────┐        ┌─────────────────────┐
│ PostgreSQL  │        │    Redis    │        │  Google Drive API   │
│ usuarios,   │        │  cola de    │        │  (una credencial    │
│ cuentas,    │        │ transfer.   │        │   por cuenta        │
│ tokens cifr.│        │             │        │   vinculada)        │
└─────────────┘        └─────────────┘        └─────────────────────┘
```

### Las tres decisiones que sostienen el diseño

**1. El `refresh_token` nunca se guarda en claro.**
Se cifra con AES-256-GCM y se almacena como sobre `base64(iv‖authTag‖ciphertext)`.
Los datos asociados autenticados (AAD) son `userId:googleUserId`, lo que ata
criptográficamente cada sobre a su fila: copiar el token de un tenant a otro
en la base de datos no sirve para usarlo, porque el descifrado falla. La clave
maestra admite **rotación por versiones** (`TOKEN_ENCRYPTION_KEYS`), y los
sobres antiguos se re-cifran solos la próxima vez que se usan.

**2. El refresco de credenciales es invisible para el cliente.**
`GoogleTokenService` es el único punto que descifra tokens y habla con el
endpoint de OAuth. Cachea el `access_token` por cuenta con un margen de
seguridad, **deduplica refrescos concurrentes** (diez peticiones simultáneas de
la misma cuenta producen una sola llamada a Google) y, si Google responde
`invalid_grant`, marca **solo esa cuenta** como `NEEDS_REAUTH` sin afectar a las
demás del mismo usuario.

**3. Los bytes nunca tocan el servidor.**
Subidas, descargas y transferencias entre cuentas son streams de extremo a
extremo (`busboy` → `googleapis`). Un archivo de 2 GB se sube con memoria
constante y sin escribir en disco, que es lo que hace viable el requisito de
coste cero de almacenamiento central.

---

## 2. Puesta en marcha

### Requisitos

- Node.js ≥ 20
- PostgreSQL 14+ y Redis 6+ (hay un `docker-compose.yml` con ambos)
- Un proyecto de Google Cloud con la **Google Drive API** habilitada

### Paso 1 — Credenciales de Google Cloud

1. [Google Cloud Console](https://console.cloud.google.com/) › crea un proyecto.
2. **APIs y servicios › Biblioteca** › habilita **Google Drive API**.
3. **Pantalla de consentimiento de OAuth** › tipo *Externo* › añade tu cuenta
   como *usuario de prueba*.
4. **Credenciales › Crear credenciales › ID de cliente de OAuth** › tipo
   *Aplicación web*. En **URI de redireccionamiento autorizados** añade,
   exactamente:
   ```
   http://localhost:3000/google/callback
   ```
5. Copia el `client_id` y el `client_secret` al `.env`.

> **Sobre el scope `drive`:** da control total del Drive del usuario y es un
> *scope restringido*. En modo prueba funciona con hasta 100 usuarios; para
> salir a producción Google exige verificación con auditoría de seguridad
> (CASA). Si no la quieres, cambia `GOOGLE_SCOPES` a
> `https://www.googleapis.com/auth/drive.file`: no requiere auditoría, pero la
> aplicación solo verá los archivos que ella misma cree.

### Paso 2 — Configuración

```bash
cp .env.example .env
npm run keygen   # genera TOKEN_ENCRYPTION_KEY (32 bytes en base64)
npm run keygen   # genera también un JWT_SECRET
```

Rellena en `.env` como mínimo: `DATABASE_URL`, `JWT_SECRET`,
`TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y
`GOOGLE_REDIRECT_URI`. La aplicación **valida la configuración al arrancar** y
se niega a escuchar si algo falta o es inválido (por ejemplo, una clave de
cifrado que no mida 32 bytes).

> ⚠️ Si pierdes `TOKEN_ENCRYPTION_KEY`, los `refresh_token` almacenados son
> irrecuperables y todos los usuarios tendrán que volver a vincular sus cuentas.

### Paso 3 — Infraestructura y base de datos

```bash
docker compose up -d        # PostgreSQL + Redis
npm install
npx prisma migrate deploy   # aplica prisma/migrations/0_init
npm run start:dev
```

### Paso 4 — Panel web (opcional, para probar sin curl)

```bash
cd frontend
cp .env.example .env        # VITE_API_URL=http://localhost:3000
npm install
npm run dev                 # http://localhost:5173
```

App de React + Vite en `frontend/`. Cubre el flujo completo: registro/login,
vincular varias cuentas de Google, explorar/subir/descargar/mover archivos,
transferir archivos y carpetas entre cuentas (con vista previa y arrastrando
a otra cuenta de la barra lateral), vista agregada de cuota y búsqueda, plan
de redistribución y seguimiento de transferencias en cola. Los tokens se
guardan en `localStorage` del navegador por comodidad de desarrollo.

El puerto 5173 es fijo (`strictPort`) porque es el origen que
`CORS_ORIGINS` y `POST_LINK_REDIRECT_URL` traen preconfigurado en
`.env.example`, para que el callback de Google vuelva directo al panel.

---

## 3. API

Todas las rutas requieren `Authorization: Bearer <accessToken>` salvo
`/auth/register`, `/auth/login`, `/auth/refresh`, `/google/callback` y `/health`.

### Identidad de la plataforma

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/auth/register` | Crea el tenant. Devuelve `accessToken` + `refreshToken`. |
| `POST` | `/auth/login` | Inicia sesión. |
| `POST` | `/auth/refresh` | Rota el refresh token (el anterior queda revocado). |
| `POST` | `/auth/logout` | Revoca una sesión. |
| `POST` | `/auth/logout-all` | Revoca todas las sesiones del usuario. |
| `GET` | `/auth/me` | Perfil y número de cuentas vinculadas. |

### Vinculación de cuentas de Google

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/google/link` | Devuelve `authUrl` a la que navegar para consentir. |
| `GET` | `/google/callback` | Lo invoca Google. Guarda el `refresh_token` cifrado. |
| `GET` | `/accounts` | Cuentas vinculadas, con su estado. |
| `PATCH` | `/accounts/:id` | Renombra el alias de una cuenta. |
| `DELETE` | `/accounts/:id` | Revoca el acceso en Google y borra la credencial. |
| `POST` | `/accounts/:id/reauth` | URL de reconsentimiento para una cuenta en `NEEDS_REAUTH`. |

`POST /google/link` devuelve JSON (y no un 302) porque exige cabecera
`Authorization`, que un redirect del navegador no puede llevar: es el panel
quien navega a `authUrl`.

### Drive — una cuenta concreta

Prefijo `/drive/:accountId`, donde `accountId` es el que el usuario selecciona
en el panel.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/files?parentId=&name=&kind=&pageSize=&pageToken=` | Listar carpeta. |
| `GET` | `/files/:fileId` | Metadatos. |
| `GET` | `/files/:fileId/link` | `webViewLink`, `webContentLink` y ruta de proxy. |
| `GET` | `/files/:fileId/download` | Descarga en streaming (exporta los Docs nativos). |
| `POST` | `/files?parentId=&name=` | **Sube** por streaming (multipart o cuerpo binario). |
| `POST` | `/folders` | Crea una carpeta. |
| `POST` | `/folders/path` | Crea una ruta completa (`informes/2026/Q1`) reutilizando lo que exista. |
| `PATCH` | `/files/:fileId` | Renombra y/o mueve (`name`, `parentId`, `trashed`). |
| `DELETE` | `/files/:fileId?permanent=` | Papelera (por defecto) o borrado definitivo. |
| `GET` | `/quota` | Cuota de esa cuenta, con el desglose Drive / papelera / Gmail + Fotos (`usageOutsideDrive`). |
| `DELETE` | `/trash` | **Vacía la papelera** de esa cuenta (irreversible) → `{ freedBytes }`. |

### Drive — vista unificada de todas las cuentas

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/drive/files` | Raíz de cada cuenta en una respuesta. |
| `GET` | `/drive/search?q=` | Búsqueda simultánea en todas las cuentas. |
| `GET` | `/drive/quota` | Cuota por cuenta, totales y cuenta recomendada para subir. |
| `GET` | `/drive/quota/history?days=` | Evolución de la cuota de cada cuenta (1–365 días, 30 por defecto), según las mediciones del vigía. No llama a Google. |
| `GET` | `/drive/rebalance/plan?threshold=` | **Propone** redistribuir (no ejecuta nada). |
| `POST` | `/drive/transfers` | Encola una transferencia entre dos cuentas → `202 {jobId}`. |
| `POST` | `/drive/transfers/preview` | Qué supondría transferir unos elementos: archivos, bytes, documentos de Google, conflictos de nombre y si cabe. No ejecuta nada. |
| `POST` | `/drive/transfers/batch` | Encola un **lote**: varios archivos y/o carpetas completas → `202 {jobId}`. |
| `GET` | `/drive/transfers/:jobId` | Progreso y resultado. |

Los endpoints agregados son **tolerantes a fallos parciales**: devuelven
`{ results, failures }`, de modo que una cuenta que necesite reautorización no
impide ver las demás.

### Ejemplo: de cero a archivo subido

```bash
# 1. Registro
TOKEN=$(curl -s -X POST localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"yo@ejemplo.com","password":"contrasena-larga"}' | jq -r .accessToken)

# 2. Vincular la primera cuenta de Google (abre authUrl en el navegador)
curl -s -X POST localhost:3000/google/link -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"alias":"Personal"}' | jq -r .authUrl

# 3. Repite el paso 2 para la segunda cuenta ("Trabajo"): el selector de
#    cuentas de Google aparece siempre, así que no se solapan.
curl -s localhost:3000/accounts -H "authorization: Bearer $TOKEN" | jq '.[].email'

# 4. Subir un archivo a una cuenta concreta
ACC=$(curl -s localhost:3000/accounts -H "authorization: Bearer $TOKEN" | jq -r '.[0].id')
curl -s -X POST "localhost:3000/drive/$ACC/files" \
  -H "authorization: Bearer $TOKEN" -F file=@./informe.pdf | jq '{id,name,size}'

# 5. Vista agregada de cuota
curl -s localhost:3000/drive/quota -H "authorization: Bearer $TOKEN" | jq .totals
```

---

## 4. Redistribución por cuota

El sistema **nunca mueve archivos por decisión propia**. El flujo es:

1. `GET /drive/rebalance/plan` analiza las cuotas y devuelve un plan: qué
   cuentas superan el umbral (`REBALANCE_THRESHOLD`, 0.9 por defecto), qué
   archivos propone mover (los más grandes primero), a qué cuenta destino y
   cuántos bytes liberaría. **No ejecuta nada.**
2. El panel muestra el plan y el usuario aprueba los movimientos que quiera.
3. Por cada uno, `POST /drive/transfers` con `deleteSource: true` (y, si el
   usuario quiere liberar la cuota al instante, `permanentlyDeleteSource: true`).

Entre cuentas de Google distintas no existe un `move` nativo (son usuarios
diferentes), así que una transferencia es copiar y luego borrar. El borrado del
original tiene tres salvaguardas:

- Se **verifica la integridad** de la copia (md5, o tamaño si Google no publica
  checksum) **antes** de tocar el original. Si no se puede verificar, la copia
  se queda y el original no se toca.
- Por defecto el original va a la **papelera**: el usuario conserva 30 días
  para deshacer. Solo con `permanentlyDeleteSource: true`, que el usuario
  activa explícitamente, se borra para siempre (tras la misma verificación).
- Los **documentos nativos de Google** (Docs, Sheets, Slides) se pueden copiar
  pero no mover: la copia es una conversión a `.docx`/`.xlsx`, no un duplicado
  idéntico, así que no es verificable y borrar el original destruiría el único
  ejemplar del documento vivo.

### Transferir carpetas y varios elementos a la vez

`POST /drive/transfers/batch` acepta archivos y carpetas mezclados. El trabajo
recorre cada carpeta, recrea su estructura en el destino y transfiere archivo
por archivo con las mismas salvaguardas de arriba. Además:

- **Fallos parciales**: un archivo que falla no detiene el lote. Cada resultado
  guarda su carpeta destino (`targetParentId`), así que el panel puede
  reintentar solo los fallidos.
- **Carpeta de origen**: al mover, solo se borra si al final queda vacía (se
  vuelve a comprobar el origen antes de borrarla).
- **Conflictos de nombre**: `onConflict: "merge"` (por defecto) reutiliza la
  carpeta que ya exista en el destino y no vuelve a subir los archivos con el
  mismo md5, ni los documentos de Google cuya copia convertida («Acta.docx»)
  sea posterior a su última edición; `"rename"` crea «Nombre (2)».
- **Se saltan** los accesos directos, los documentos de Google sin formato
  exportable y, al mover, los archivos de otros propietarios (no ocupan tu
  cuota y no se pueden borrar).

`POST /drive/transfers/preview` devuelve lo mismo que verá el usuario antes de
confirmar: número de archivos y carpetas, bytes, documentos de Google,
conflictos y si cabe en el destino.

El plan reserva el mismo margen en la cuenta destino: llenar otra cuenta al
100 % solo trasladaría el problema.

### Vigía de cuota (opcional, desactivado por defecto)

Con `QUOTA_WATCH_ENABLED=true`, un job periódico (`QUOTA_WATCH_CRON`) mide la
cuota de todas las cuentas y guarda la foto en `quota_snapshots`, para que el
panel pueda avisar antes de que una cuenta se llene sin llamar a Google en cada
carga. **Solo mide y registra: no mueve nada.**

Cada medición se añade también al histórico (`quota_samples`), que alimenta
`GET /drive/quota/history`. Las muestras más antiguas que `QUOTA_HISTORY_DAYS`
(90 por defecto) se purgan en cada pasada. Con el vigía apagado el histórico
queda vacío, y la respuesta lo indica con `watchEnabled: false` para que el
panel distinga "sin cambios" de "nadie mide".

---

## 5. Estados de una cuenta vinculada

| Estado | Significado | Qué debe hacer el panel |
|---|---|---|
| `ACTIVE` | Credenciales válidas. | Operar con normalidad. |
| `NEEDS_REAUTH` | Google devolvió `invalid_grant`: el usuario revocó el acceso, cambió la contraseña, el token caducó por inactividad, o la app sigue en modo *testing* (donde los refresh_token expiran en 7 días). | Mostrar el aviso y llevar al usuario a `POST /accounts/:id/reauth`. |
| `UNLINKED` | Desvinculada por el usuario; el sobre cifrado se ha borrado. | Ocultarla. |

Las operaciones sobre una cuenta en `NEEDS_REAUTH` responden `409` con
`code: "GOOGLE_ACCOUNT_NEEDS_REAUTH"` y el `accountId` afectado.

---

## 6. Pruebas

```bash
npm test
npm run lint      # tsc --noEmit
npm run build
```

Cubren las piezas donde un error es caro y silencioso:

- **Cifrado** (`token-crypto.service.spec.ts`): ida y vuelta, aislamiento por
  contexto (un sobre movido a otro tenant no se descifra), detección de
  manipulación, rotación de claves.
- **Motor de refresco** (`google-token.service.spec.ts`): caché, deduplicación
  de refrescos concurrentes, **cachés independientes por cuenta**, degradación
  a `NEEDS_REAUTH` ante `invalid_grant`, re-cifrado si Google rota el token.
- **Plan de redistribución** (`drive-aggregate.service.spec.ts`): selección de
  candidatos, exclusión de Docs nativos, respeto del margen del destino,
  tolerancia a fallos parciales.
- **Errores de Google** (`retry.spec.ts`): clasificación de transitorios vs
  definitivos, `Retry-After`, backoff.
- **Grafo de dependencias** (`app-wiring.spec.ts`): toda la aplicación se
  instancia, y la configuración rechaza valores inválidos al arrancar.

---

## 7. Límites conocidos

- **La caché de `access_token` es por proceso.** Es correcto (los tokens de
  Google son reutilizables en paralelo); el coste es algún refresco extra tras
  un despliegue. Si llega a importar, el punto donde sustituirla por Redis está
  aislado en `GoogleTokenService`.
- **Solo las transferencias entre cuentas son reanudables.** Copian con el
  protocolo *resumable* de Google: si la conexión se corta, se pregunta a
  Google cuántos bytes confirmó y se vuelve a pedir el origen desde ahí
  (`Range`), sin repetir lo ya subido (`drive/resumable-upload.ts`). Las
  subidas desde el navegador siguen siendo multipart: su stream no se puede
  volver a pedir, así que reanudarlas exigiría que el propio cliente lleve la
  sesión. Los documentos de Google tampoco se reanudan: se exportan sin
  tamaño conocido, aunque son pequeños.
- **Las transferencias de carpetas se recorren en el servidor.** Una carpeta
  con decenas de miles de archivos tarda en analizarse antes de empezar, y la
  vista previa deja de contar a los 5000 archivos (avisa de que es un mínimo).
  Los documentos de Google se copian convertidos y su carpeta de origen se
  conserva al mover, porque nunca quedará vacía.
- **La papelera de Drive sigue consumiendo cuota.** Tras una redistribución con
  papelera, el espacio no se libera hasta vaciarla (`DELETE /drive/:accountId/trash`)
  o usar `permanentlyDeleteSource`. Aun así, Google tarda unos minutos en
  recalcular la cuota tras borrar.
- **Gmail y Google Fotos no se distinguen.** La Drive API solo publica el uso
  total y el de Drive; `usageOutsideDrive` es la suma de ambos.

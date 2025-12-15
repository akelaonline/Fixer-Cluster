# Fixer Cluster

Backend inicial de **Fixer Cluster**, herramienta para auditar y curar clústeres de contenidos SEO en blogs WordPress.

Este repo contiene, por ahora, solo el backend en Firebase Functions + Firestore que:

- Ingresa URLs desde los sitemaps de cada sitio.
- Guarda la estructura de sitios/URLs en Firestore.
- Expone endpoints HTTP que luego usará el plugin de WordPress y el dashboard externo.

## Stack

- Firebase Functions (Node 20, TypeScript).
- Firestore (modo emulador en dev).
- Storage (para futuros dumps de HTML / embeddings).
- Java 21 (para Firestore emulator).

## Estructura de proyecto

```text
/firebase.json        # Config de emuladores y servicios
/.firebaserc          # ProjectId por defecto (fixer-cluster)
/firestore.rules      # Reglas de Firestore (cerradas por defecto)
/storage.rules        # Reglas de Storage (cerradas por defecto)
/functions/
  package.json        # Dependencias y scripts de Functions (TS)
  tsconfig.json       # Config de TypeScript
  src/index.ts        # API HTTP principal (Express + Functions)
  lib/                # Salida compilada (generada por tsc)
```

## Firestore (schema actual)

Colecciones usadas en esta primera versión:

- `sites/{siteId}`
  - `sitemapUrl: string | null`
  - `urlCount: number`
  - `updatedAt: Timestamp`

- `sites/{siteId}/urls/{urlId}`
  - `loc: string` (URL completa)
  - `lastmod: string | null` (desde el sitemap)
  - `source: "sitemap" | "direct" | "sitemap-or-gsc"`
  - `sitemapUrl: string | null` (si aplica)
  - `fetchedAt: Timestamp`

- `ingest_gsc_mock` (para pruebas)
  - `siteId: string`
  - `rows: any[]`
  - `createdAt: Timestamp`

- `actions_apply` (cola de acciones a aplicar en WP)
  - `siteId: string`
  - `actionId: string`
  - `payload: Record<string, any>`
  - `createdAt: Timestamp`

Más adelante se añadirán colecciones para `clusters` y `gsc_data` reales.

## Endpoints HTTP (emulador)

Todos colgados en la función HTTPS `api` (Express):

En producción, los endpoints de escritura requieren auth por token en header:

- `x-fixer-token: <TOKEN>`

En emulador/local, si no hay token configurado, se permite.

- `POST /ingest/sitemap`
  - Body JSON: `{ "siteId": string, "sitemapUrl": string }`
  - Acción: descarga el sitemap (índice o urlset), recorre hasta 3 niveles y guarda todas las URLs en `sites/{siteId}/urls`.
  - Respuesta: `{ ok: true, count: number }`.

- `POST /ingest/urls`
  - Body JSON: `{ "siteId": string, "urls": string[] | { loc: string, lastmod?: string }[] }`
  - Acción: ingesta directa de URLs (útil cuando un WAF/captcha bloquea el acceso al sitemap desde Cloud Functions). Guarda/mergea en `sites/{siteId}/urls`.
  - Respuesta: `{ ok: true, count: number }`.

- `POST /ingest/gsc-mock`
  - Body JSON: `{ "siteId": string, "rows": any[] }`
  - Acción: guarda un batch de datos de Search Console de prueba en `ingest_gsc_mock`.

- `POST /actions/apply`
  - Body JSON: `{ "siteId": string, "actionId": string, "payload": any }`
  - Acción: encola acciones a aplicar en el sitio (enlazado interno, cambios on-page, etc.).

## Desarrollo local

### Requisitos

- Node.js 20 recomendado para build/deploy.
- Firebase CLI instalado (`firebase-tools`).
- Java 21+ (instalado vía Homebrew: `brew install --cask temurin@21`).

### Instalar dependencias

```bash
npm install --prefix functions
```

### Compilar Functions (TypeScript → JS)

```bash
npm run build --prefix functions
```

### Levantar emuladores (functions, firestore, storage)

```bash
JAVA_HOME="$(/usr/libexec/java_home -v 21)" \
  firebase emulators:start --only functions,firestore,storage
```

El CLI mostrará algo como:

- Functions: `http://127.0.0.1:5001/fixer-cluster/us-central1/api`
- Firestore: `127.0.0.1:8080`
- UI de emulador: `http://127.0.0.1:4000`

### Probar ingesta de un sitemap

Ejemplo para `visaparaestadosunidos.com` (siteId = `visa-es`):

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"siteId":"visa-es","sitemapUrl":"https://visaparaestadosunidos.com/sitemap_index.xml"}' \
  http://127.0.0.1:5001/fixer-cluster/us-central1/api/ingest/sitemap
```

Respuesta esperada:

```json
{"ok": true, "count": 193}
```

Luego se pueden inspeccionar los documentos en la UI del emulador de Firestore (`/firestore`).

## Próximos pasos (roadmap corto)

- Añadir ingesta real de Search Console (API) y normalizar `gsc_data` por URL/consulta.
- Motor de clustering con embeddings (OpenAI) y reglas SEO.
- Generación de `actions` priorizadas por impacto (quick wins, canibalización, huérfanas, etc.).
- Dashboard externo + plugin de WordPress con toggles de automatización.

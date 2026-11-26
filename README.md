# Aprovisionador "WhatsApp + Llamadas" (Chatwoot + AstraCalls)

Permite que un **administrador** de una cuenta de Chatwoot conecte su número de WhatsApp a AstraCalls por autoservicio,
desde **Configuración → Bandejas de entrada → Agregar** (`/app/accounts/{id}/settings/inboxes/new`), sin intervención manual.

```
Navegador (Chatwoot)                Provisioner (este proyecto)             AstraCalls / Chatwoot
 connector.js ──headers devise──►  POST /provision
                                     1. GET  /api/v1/profile  (¿administrator?)   ──► Chatwoot
                                     2. POST /api/sessions {name}                 ──► AstraCalls
                                     3. POST /api/v1/accounts/{id}/inboxes (api)  ──► Chatwoot
                                     4. POST /api/sessions/{sid}/chatwoot {...}   ──► AstraCalls
                                     5. PUT  /api/sessions/{sid}/recording        ──► AstraCalls (opcional)
                                     6. QR (ya iniciado por la sesión) o POST .../pair-code
 connector.js ──polling──────────►  GET /provision/{id}/status  (QR / código / conectado)
 connector.js ── cancelar ───────►  DELETE /provision/{id}      (revierte lo creado)
```

Si cualquier paso falla se **revierte** lo creado (bandeja y sesión) y se devuelve un error claro en español.

## Estructura

Licencia MIT.

```
server/                 Backend Node 20 + Express (sin base de datos)
  src/                  config, clientes de Chatwoot/AstraCalls, lógica, app
  public/connector.js   Script para "Dashboard Scripts" (JS puro, QR embebido)
  test/                 Pruebas con mocks (node --test)
  Dockerfile
deploy/compose-snippet.yml   Servicio a añadir al stack de AstraCalls en Coolify (opción compose)
```

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ASTRACALLS_URL` | no (def. `http://host.docker.internal:8091`) | URL **interna** de AstraCalls. |
| `ASTRACALLS_API_KEY` | **sí** | API key **maestra** de AstraCalls (`WACALLS_API_KEY`). Nunca se registra en logs ni se envía al navegador. |
| `ASTRACALLS_PUBLIC_URL` | **sí** | URL pública de AstraCalls tal como la alcanza Chatwoot. Se usa para el webhook de la bandeja: `{ASTRACALLS_PUBLIC_URL}/api/sessions/{sid}/chatwoot/webhook`. |
| `CHATWOOT_URL` | **sí** | URL de Chatwoot (la usa el provisioner y se guarda en la config de Chatwoot de AstraCalls). |
| `ALLOWED_ORIGIN` | **sí** | Único origen permitido por CORS (el de Chatwoot, sin `/` final). |
| `ALLOWED_ACCOUNT_IDS` | no | Lista de cuentas habilitadas separadas por comas (ej. `1,7`). Si está definida y la cuenta no figura → **403** "Esta cuenta no tiene habilitado WhatsApp + Llamadas. Contacta a soporte.". Vacía = todas permitidas. |
| `CAPI_SECRET` | no | Llave para cifrar los datos de Meta (API de conversiones) de cada cuenta. Sin ella, la sección "Conexión con Meta" queda desactivada. Una cadena aleatoria larga; si se cambia, hay que volver a guardar la conexión en cada cuenta. |
| `DATA_DIR` | no (`/data`) | Carpeta persistente donde se guarda `capi.json` (tokens cifrados). Montar un volumen ahí. |
| `PUBLIC_URL` | no | URL pública del provisioner, usada para el webhook de CAPI que se crea en cada cuenta de Chatwoot (ej. `https://provision.example.com`). Si falta, se deduce de la petición. |
| `MAX_SESSIONS_PER_ACCOUNT` | no (1) | Máximo de números por cuenta. Se cuentan las bandejas de la cuenta (`GET /api/v1/accounts/{id}/inboxes`, con el token del usuario) cuyo `webhook_url` empieza con `ASTRACALLS_PUBLIC_URL`. Si ya se alcanzó → **409** "Alcanzaste el límite de números de tu plan.". |
| `EVOLUTION_URL` | no | URL de Evolution API. Si está junto con `EVOLUTION_API_KEY`, al conectar una bandeja existente que venía de ese Evolution se cierra la sesión de su instancia (ver abajo). |
| `EVOLUTION_API_KEY` | no | API key global de Evolution. Nunca se registra en logs. |
| `MCP_KEYS_PER_INBOX` | no (1) | Llaves MCP que el cliente puede crear por bandeja desde Chatwoot. |
| `PORT` | no (3000) | Puerto del servicio. |
| `TRUST_PROXY` | no (1) | Saltos de proxy confiables para el rate limit por IP (Traefik de Coolify = 1). |
| `RATE_IP_PER_MIN` | no (20) | `POST /provision` por IP/min (el status/cancel permite ×12). |
| `RATE_ACCOUNT_PER_MIN` | no (10) | `POST /provision` por cuenta/min. |
| `PROVISIONS_PER_ACCOUNT_PER_HOUR` | no (10) | Aprovisionamientos exitosos por cuenta por hora. |
| `HTTP_TIMEOUT_MS` | no (15000) | Timeout de cada llamada a Chatwoot/AstraCalls. |
| `PROVISION_TTL_MS` | no (900000) | Vida de una solicitud (15 min). Pasado ese tiempo, si no se conectó, **se revierte** (se borran sesión y bandeja). |

## Despliegue en Coolify

1. **Sube la carpeta `server/`** a un repositorio Git (o a tu registro de imágenes) accesible por Coolify.
2. En el compose del stack de AstraCalls **añade** el servicio de `deploy/compose-snippet.yml` (no modifica los existentes).
   - Usa `extra_hosts: host.docker.internal:host-gateway` (igual que tu puente socat) y `ASTRACALLS_URL=http://host.docker.internal:8091`.
   - **Requisito:** AstraCalls (network_mode host, `:8091`) debe aceptar conexiones desde la red de Docker (escuchar en `0.0.0.0` o en la IP del puente `docker0`), igual que ya requiere tu puente socat. Prueba: desde el contenedor, `wget -qO- --header "X-API-Key: ..." http://host.docker.internal:8091/api/config`.
3. En Coolify define las variables: `ASTRACALLS_API_KEY`, `ASTRACALLS_PUBLIC_URL`, `CHATWOOT_URL`, `ALLOWED_ORIGIN`.
4. Asigna el dominio **`https://provision.example.com`** al servicio `provisioner` (puerto 3000) y activa HTTPS.
5. Despliega y verifica: `curl https://provision.example.com/healthz` → `{"ok":true,"version":"prov-v1.0.4","commit":"abc1234"}` y `curl -I https://provision.example.com/connector.js` → 200.

### Alternativa: desplegar desde GitHub (sin construir imagen en local)

Coolify construye la imagen por ti a partir del repositorio; no necesitas Docker en tu equipo.

1. El código está en este repositorio público (rama `main`). No contiene secretos:
   todas las llaves van en las variables de entorno de Coolify.
2. En Coolify: **+ New → Application → Public Repository** con la URL de este repositorio
   y la rama `main`. (Para **Auto Deploy** en cada push, usa en su lugar *Private Repository (with GitHub App)*, que también sirve para repos públicos.)
3. Configuración de la aplicación:
   - **Build Pack:** `Dockerfile`
   - **Base Directory:** `/server`  ·  **Dockerfile Location:** `/Dockerfile`
   - **Ports Exposes:** `3000`
   - **Domains:** `https://provision.example.com`
   - **Health check path:** `/healthz`
4. **Environment Variables:** `ASTRACALLS_URL=http://host.docker.internal:8091`, `ASTRACALLS_API_KEY`, `ASTRACALLS_PUBLIC_URL`,
   `CHATWOOT_URL`, `ALLOWED_ORIGIN` y, si aplica, `ALLOWED_ACCOUNT_IDS`, `MAX_SESSIONS_PER_ACCOUNT`.
   Marca `ASTRACALLS_API_KEY` como secreta.
5. **Advanced → Custom Docker Options:** `--add-host=host.docker.internal:host-gateway`
   (equivale al `extra_hosts` del compose; así el contenedor llega a AstraCalls en el host, puerto 8091).
6. Despliega. Con **Auto Deploy** activo, cada `git push` a `main` vuelve a desplegar.

En este modo el provisioner es una aplicación independiente en Coolify; no hace falta tocar el compose de AstraCalls.

## DNS

Crea un registro **A** (o CNAME) `provision.example.com` apuntando al mismo servidor/proxy de Coolify que usan tus otros dominios.
Si usas Cloudflare, puede estar proxied (naranja); no requiere WebSockets.

## Cómo cargar el script en Chatwoot

En Chatwoot existe la configuración de **Dashboard Scripts** (consola *Super Admin → Settings*; el nombre exacto puede variar según versión). Pega:

```html
<script src="https://provision.example.com/connector.js" data-provisioner="https://provision.example.com"></script>
```

El script solo actúa en `/app/accounts/{id}/settings/inboxes/new`. Si la pantalla cambia y no encuentra la rejilla de canales, **no hace nada**.
Si tu Chatwoot define una Content-Security-Policy estricta, añade `provision.example.com` a `script-src` y `connect-src`.

## API del provisioner

Todas las rutas (salvo `/connector.js` y `/healthz`) exigen los headers devise del usuario (`access-token`, `client`, `uid`),
que el script lee de la cookie `cw_d_session_info`, y solo aceptan CORS desde `ALLOWED_ORIGIN`.

- `POST /provision` `{accountId, inboxName, phone, record, method:"qr"|"code", importHistory?, importHistoryDays?: 7|30|90, mirrorApi?, existingInboxId?}` → `201 {provisionId}`
- `GET /inbox/available?accountId` → `{inboxes:[{id, name}]}`: bandejas de tipo API de la cuenta que todavía no están conectadas a AstraCalls
- `GET /provision/{id}/status` → `{state: starting|qr|code|connected|expired|cancelled, qr?, code?, inboxId, accountId, connectedPhone?}`
- `DELETE /provision/{id}` → cancela y revierte (si aún no se conectó)

Bandejas ya conectadas (el script las muestra al final de la pestaña **Configuración** de la bandeja):

- `GET /inbox/settings?accountId&inboxId` → `{managed, connected, phone, recording, mirrorApi, importHistory, importHistoryDays, mcpEndpoint}`
- `PUT /inbox/settings` `{accountId, inboxId, recording?, mirrorApi?, importHistory?, importHistoryDays?}` → misma forma
- `GET /inbox/mcp-keys?accountId&inboxId` → `{endpoint, max, keys:[{id, name, prefix, readOnly, createdAt, lastUsedAt}]}` (nunca incluye el secreto)
- `POST /inbox/mcp-keys` `{accountId, inboxId, name, readOnly}` → `201 {key, secret, endpoint, url}` (el secreto se muestra **una sola vez**; `409` si la bandeja ya tiene su llave)
- `GET /aviso-ia` → página pública con el aviso de uso responsable de IA (bloqueos, spam, privacidad, responsabilidad)

Revocar llaves **no** está expuesto a los clientes: lo hace el administrador desde el botón **MCP** del panel de AstraCalls.

### Opciones de la conexión

| Opción | Por defecto | Qué hace |
|---|---|---|
| Grabar llamadas | sí | Graba las llamadas y las deja como nota privada en Chatwoot. |
| Checks de entregado y leído | sí* | Los mensajes del agente muestran ✓✓ entregado / leído; un envío fallido queda marcado con el motivo. |
| Lo escrito desde el celular como mensaje normal | sí* | Entra como mensaje de salida en vez de nota privada. Cuenta como respuesta humana: abre conversaciones pendientes de bots. |
| Conversaciones nuevas: abiertas / pendientes | abiertas* | Con **pendientes**, cada conversación nueva espera a que la atienda primero un asistente de Captain (o un bot) conectado a la bandeja. |
| Al archivar un chat en WhatsApp: no sincronizar / resuelta / pendiente | no sincronizar* | Espejo en los dos sentidos: archivar en WhatsApp resuelve (o deja pendiente) la conversación, y resolver en el CRM archiva el chat. Desarchivar o reabrir vuelve a abrirlo en ambos lados. |
| Leer mensajes automáticamente | no | Marca como leído todo lo que llega. Apagado, los mensajes se marcan como leídos cuando alguien responde desde Chatwoot*. |
| Siempre en línea | no | El número aparece "en línea" todo el tiempo; mientras está encendido, el celular deja de recibir notificaciones. |
| Importar conversaciones anteriores (7/30/90 días) | no | Trae el historial de chats 1:1 con su fecha original, sin reenviar nada. **Solo funciona si está activa al vincular** el número. Las conversaciones importadas quedan resueltas* (no llenan la bandeja ni las atiende Captain). |
| Mostrar mensajes enviados por API | no | Lo que se envía por la API de AstraCalls (ej. n8n) aparece como nota privada en la conversación. |

### Conectar una bandeja existente

En el modal se puede elegir **"Usar una bandeja existente"** en vez de crear una nueva. El desplegable muestra
solo las bandejas de **tipo API** de la cuenta que aún no están conectadas a AstraCalls (por ejemplo, una que
usaba otro conector de WhatsApp). Así se conservan el historial, los contactos, los agentes, las automatizaciones
y los flujos que usan el ID de la bandeja.

- El provisioner solo cambia el **webhook** de la bandeja para que apunte a la sesión nueva. Nunca la borra:
  si se cancela, expira o falla un paso, le devuelve su webhook anterior.
- **Importar conversaciones queda desactivado**: ese historial ya está en Chatwoot y se duplicaría.
- Antes de conectar, hay que apagar el número en el servicio anterior; si no, cada mensaje entraría dos veces.
- **Si la bandeja viene de Evolution** (su webhook es `{EVOLUTION_URL}/chatwoot/webhook/{instancia}` y están
  configuradas `EVOLUTION_URL` y `EVOLUTION_API_KEY`), el modal muestra un aviso de que el número dejará de
  funcionar en el otro proveedor. Cuando el número **ya quedó vinculado** en AstraCalls, el provisioner cierra la
  sesión de esa instancia (`DELETE /instance/logout/{instancia}`); no la borra. Si se cancela o el QR expira,
  Evolution no se toca.

### Recuperar un número desvinculado

Si se borra en Chatwoot la bandeja de un número, AstraCalls (rama `lhcia`) lo **desvincula** de WhatsApp y guarda
la sesión **24 horas** (historial, llaves MCP y configuración) antes de borrarla. Mientras tanto, el modal muestra
el bloque **"¿Qué número?"** con la opción **"Recuperar un número desvinculado"** y la cuenta atrás de cada uno.

- Se elige el número, una bandeja (nueva o existente) y se vincula con QR o código **con el mismo número**.
- La bandeja borrada perdió sus conversaciones: se puede activar **Importar conversaciones**.
- El plazo de 24 h solo se detiene cuando el número **vuelve a vincularse**. Si se cancela o expira, se borra la
  bandeja nueva pero no la sesión, que sigue en su plazo.
- Solo aparecen los números de **esa cuenta y ese Chatwoot** (`GET /api/orphans` de AstraCalls, filtrado).

### Editar mensajes desde Chatwoot

Chatwoot no permite editar un mensaje ya enviado. El script agrega **"Editar"** al menú del mensaje (clic derecho
o los tres puntos) en los mensajes **de texto enviados** (no en notas privadas ni entrantes).

- El agente escribe el texto nuevo; el provisioner valida **con la sesión de Chatwoot del agente** que pertenece a la
  cuenta y tiene acceso a esa conversación (cualquier agente, no solo administradores) y llama a AstraCalls con la
  llave maestra (`POST /api/sessions/{sid}/chatwoot/messages/{id}/edit`, rama `lhcia`).
- AstraCalls edita el mensaje en WhatsApp si salió por WhatsApp desde la cuenta, es de texto y no pasaron **15 minutos**.
- El mensaje de Chatwoot no cambia: queda una **nota privada "✏️ Editado en WhatsApp:"** con el texto nuevo.
- Si no se puede (adjunto, más de 15 min…), el agente ve el motivo.

\* Requieren una versión de AstraCalls que lo soporte (`read_receipts`, `device_mode`, `conversation_status`, leído al responder); con otra versión no tienen efecto.

### Conectar una IA (MCP)

Cada bandeja puede generar **una llave MCP** de AstraCalls (configurable con `MCP_KEYS_PER_INBOX`). La llave da acceso **solo a ese número**
(leer y enviar mensajes, contactos, llamadas) y no permite desconectarlo, re-vincularlo ni cambiar su configuración. Puede ser de **solo lectura**.
Para crearla, el administrador debe marcar que leyó y acepta el aviso de uso responsable (`/aviso-ia`). La llave se muestra una sola vez;
si se pierde o se filtra, el administrador de AstraCalls la revoca desde su panel y el cliente puede crear otra.
La IA se conecta a `https://<ASTRACALLS_PUBLIC_URL>/mcp/<llave>`, o al servidor `.../mcp` con `Authorization: Bearer <llave>`.

Seguridad: el usuario debe ser `administrator` de `accountId` (se revalida en cada consulta, con caché de 15 s); una solicitud solo la puede ver quien la creó;
teléfono validado (8–15 dígitos, código de país); nombre saneado; rate limit por IP y por cuenta; timeouts en todas las llamadas; sin tokens en logs; estado solo en memoria.
Para bandejas ya conectadas, la sesión se deduce del webhook de la bandeja **y se verifica** que la configuración de esa sesión en AstraCalls
sea de la misma cuenta, la misma bandeja y el mismo Chatwoot: apuntar el webhook de una bandeja propia a la sesión de otro cliente no da acceso a nada.

## Pruebas

```powershell
cd server
npm install
npm test        # 46 pruebas (cupos, opciones de bandeja, MCP, aviso y seguridad): flujo feliz (QR y código), 403 no-admin, rollback en cada paso, cancelar, expiración,
                # CORS, rate limit, ausencia de secretos en logs, SSE, decodificación del QR, inyección en el DOM
```

### Plan de pruebas manual (antes de abrir a clientes)

1. **Backend aislado:** `/healthz` OK; `connector.js` se descarga; `OPTIONS /provision` desde otro origen → 403.
2. **Usuario agente (no admin):** abrir la pantalla → al conectar debe mostrar el error "Solo un administrador…" y no crear nada.
3. **Administrador, método QR:** crear con "Grabar llamadas" activo → aparece el QR → escanear → "¡Listo!" → redirige a la bandeja.
   Verificar en AstraCalls: sesión creada, Chatwoot configurado (inbox_id correcto), grabación activa; en Chatwoot: bandeja API con el webhook de la sesión.
4. **Método código:** se muestra el código de 8 caracteres; vincular desde WhatsApp → conectado.
5. **Mensajes:** enviar/recibir un mensaje y una llamada; comprobar la grabación.
6. **Cancelar** durante el emparejamiento → la bandeja y la sesión desaparecen. **Dejar expirar** 15+ min → idem.
7. **Fallo inducido:** apagar AstraCalls o usar una API key errónea → error claro en español y sin bandejas huérfanas.
8. **Modo oscuro/claro** y **navegación SPA** (entrar a la pantalla desde otras secciones, sin recargar).

## Supuestos / puntos a validar en tu entorno

- **El QR no está en REST.** En AstraCalls v1.1.5 el QR solo se publica por SSE (`GET /api/events`, eventos `session-qr` / `auth-state`). El provisioner mantiene **una suscripción SSE** con la API maestra y cachea QR/estado por sesión.
- **`POST /api/sessions` ya inicia el emparejamiento por QR.** Por eso el provisioner no llama a `/pair` inmediatamente; lo usa solo si el QR no llega o caduca (máx. 1 vez cada 20 s).
- **Token de la cuenta:** AstraCalls guarda como `account_token` el `access_token` personal del administrador que aprovisiona (así lo pide el diseño). Si ese usuario es eliminado o rota su token, la integración dejará de poder escribir en Chatwoot. Considera un usuario administrador "de servicio" por cuenta.
- El webhook de AstraCalls (`/api/sessions/{sid}/chatwoot/webhook`) está exento de la API key en AstraCalls (confirmado en `withAuth`), por eso Chatwoot puede llamarlo; debe ser alcanzable desde Chatwoot vía `ASTRACALLS_PUBLIC_URL`.
- `inbox_identifier` se toma de la respuesta de Chatwoot si existe; AstraCalls no lo exige (`valid()` solo requiere url, account_id, token e inbox_id).
- El nombre y la ubicación exacta de "Dashboard Scripts" en la consola Super Admin de Chatwoot no se verificaron contra una instancia real.
- La estructura de la rejilla de canales (botones con `h3`/`p` dentro de un `div.grid`) se tomó del código fuente de Chatwoot (`ChannelList.vue`/`ChannelSelector.vue`, rama `develop`); se probó con un clon de ese marcado en jsdom, no en un Chatwoot real.

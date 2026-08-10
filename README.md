# whatsapp-agent

Bridge de WhatsApp (Baileys) + servidor MCP de **solo lectura** para que agentes puedan leer tus chats.

Fase 1: leer. No envía mensajes, no modifica nada, y la API HTTP interna rechaza cualquier método que no sea `GET`.

---

## Arquitectura

```
  tu teléfono ──WhatsApp Web protocol──▶  wa-bridge  ──▶  ~/.whatsapp-agent/store.db
                                          (daemon)              (SQLite)
                                              │
                                              │ HTTP local, solo lectura
                                              │ 127.0.0.1:8788
                                              ▼
   Claude / cualquier agente  ◀──stdio MCP──  wa-mcp
```

Dos procesos, a propósito:

**`wa-bridge`** es un daemon que mantiene una sola sesión de WhatsApp viva y va escribiendo todo lo que llega (chats, contactos, mensajes) en SQLite. Se queda corriendo.

**`wa-mcp`** es el servidor MCP. No habla con WhatsApp: solo consulta el bridge por HTTP. Es sin estado, arranca en milisegundos, y podés tener varios agentes usándolo a la vez sin pelearse por la sesión.

Si en cambio el MCP levantara Baileys directamente, cada vez que un agente arrancara tendrías una reconexión y una re-sincronización de historial — lento, ruidoso, y WhatsApp lo ve como un dispositivo reconectándose sin parar.

---

## Instalación

Necesitás Node.js 20 o superior (`node --version`).

```bash
cd whatsapp-agent
bun install
bun run build
```

`better-sqlite3` trae binarios precompilados para macOS arm64, así que no debería compilar nada. Si por algún motivo falla, instalá las Command Line Tools de Xcode (`xcode-select --install`) y repetí `bun install`.

## Vincular tu WhatsApp

Primera vez, con QR:

```bash
node dist/bridge/index.js
```

Aparece un QR en la terminal. En el teléfono: **WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo**.

Si preferís un código de 8 dígitos en vez del QR (útil por SSH o si la terminal renderiza mal el QR):

```bash
node dist/bridge/index.js --pair 573001234567
```

Y en el teléfono: **Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono**.

Después de vincular, **dejalo corriendo unos minutos**. WhatsApp manda el historial en lotes y el bridge los va guardando. Vas a ver líneas tipo `lote de historial procesado` y al final `sincronizacion de historial completa`. Cuánto historial llega lo decide WhatsApp, no nosotros: típicamente los últimos meses de cada chat, no todo desde el inicio de los tiempos.

Las credenciales quedan en `~/.whatsapp-agent/auth/`. En los arranques siguientes no vuelve a pedir QR.

## Conectar el MCP

Con el bridge corriendo, agregá esto a tu cliente MCP.

**Claude Code** (`~/.claude.json`, o `.mcp.json` en el proyecto):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/ruta/absoluta/a/whatsapp-agent/dist/mcp/index.js"]
    }
  }
}
```

O más corto, desde la carpeta del proyecto:

```bash
claude mcp add whatsapp -- node "$PWD/dist/mcp/index.js"
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`): mismo bloque `mcpServers`.

Verificá con `whatsapp_status` — te dice si el bridge está conectado y cuántos mensajes hay guardados.

## Dashboard

Con el bridge corriendo, abrí **http://127.0.0.1:8788/** en el navegador. Es solo salud del proceso (no muestra chats ni contenido de mensajes): estado de conexión, cuenta vinculada, hace cuánto está corriendo el proceso y hace cuánto está conectado a WhatsApp, progreso del sync de historial, y los contadores de chats/mensajes/contactos guardados. Se refresca solo cada 4s. Sirve para confirmar de un vistazo que está vivo y sincronizando sin tener que leer logs.

No pide token aunque hayas configurado `WA_BRIDGE_TOKEN` (la página en sí no expone datos), pero si lo configuraste el panel no va a poder refrescar `/status` — es solo para el caso normal de uso local sin token.

## Herramientas expuestas

| Tool              | Para qué                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_status` | Estado de conexión, cuenta vinculada, cuántos chats/mensajes hay guardados, progreso del sync.                                                |
| `list_chats`      | Chats por actividad reciente. Filtros: `type` (dm/group), `unread_only`, `include_archived`, `limit`, `offset`.                               |
| `search_chats`    | Busca por nombre de contacto, nombre de grupo o número. Coincidencia parcial.                                                                 |
| `get_messages`    | Historial de una conversación. `chat` acepta JID, nombre o número. `since`/`until` aceptan ISO (`2026-08-01`) o relativo (`7d`, `12h`, `2w`). |

`get_messages` resuelve el chat por vos: no hace falta que el agente busque el JID primero. Si el nombre es ambiguo devuelve las opciones para que elija.

## Dejarlo corriendo siempre (macOS)

`launchd/local.whatsapp-bridge.plist` es una plantilla (label `local.whatsapp-bridge`, sin nada atado a ninguna empresa — es una herramienta personal). Editá las rutas (usuario, ruta del proyecto, y el binario de `node` — si usás `nvm` no es `/opt/homebrew/bin/node` sino algo como `~/.nvm/versions/node/vXX.X.X/bin/node`, confirmá con `which node`), y después:

```bash
cp launchd/local.whatsapp-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/local.whatsapp-bridge.plist
```

Con `RunAtLoad` + `KeepAlive` arranca solo al iniciar sesión y se reinicia si el proceso muere. Logs en `~/.whatsapp-agent/bridge.log`.

Para pararlo: `launchctl unload ~/Library/LaunchAgents/local.whatsapp-bridge.plist`.

Para aplicar cambios de código: `launchctl unload ...` → `bun run build` → `launchctl load ...`.

Chequeo rápido de que está vivo: `curl -s http://127.0.0.1:8788/status` (o `launchctl list | grep whatsapp-bridge`).

Una vez corriendo como daemon, ya no hace falta dejar ninguna terminal abierta — ni Claude Code ni Claude Desktop dependen de eso.

## Configuración

Todo por variables de entorno, todas opcionales.

| Variable               | Default             | Qué hace                                                                                                      |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `WA_AGENT_DIR`         | `~/.whatsapp-agent` | Dónde viven credenciales y base de datos.                                                                     |
| `WA_BRIDGE_PORT`       | `8788`              | Puerto de la API local.                                                                                       |
| `WA_BRIDGE_TOKEN`      | vacío               | Si lo definís, la API exige `Authorization: Bearer`. Definilo en ambos procesos.                              |
| `WA_SYNC_FULL_HISTORY` | `true`              | `false` para pedir menos historial y sincronizar más rápido.                                                  |
| `WA_MARK_ONLINE`       | `false`             | `true` te marca "en línea" al conectar (y tu teléfono deja de mandarte notificaciones push). Dejalo en false. |
| `WA_LOG_LEVEL`         | `info`              | `debug` cuando algo no cuadra.                                                                                |

## Pruebas

```bash
node scripts/e2e-test.mjs
```

43 pruebas: extracción de texto de mensajes, capa SQLite, API HTTP, y los 4 tools MCP ejercitados con un cliente MCP real por stdio. No toca WhatsApp.

## Cosas que conviene saber

**Baileys no es oficial.** Reimplementa el protocolo de WhatsApp Web. WhatsApp puede suspender el número. El riesgo real es bajo mientras solo leas y te comportes como un dispositivo vinculado normal, y sube bastante cuando empezás a enviar mensajes automatizados, sobre todo a números que no te escribieron primero. Fase 1 es solo lectura justamente por eso.

**`~/.whatsapp-agent/` es material sensible.** `auth/` da acceso completo a tu cuenta y `store.db` tiene tus mensajes en texto plano. No lo subas a git ni a un backup compartido. Para desvincular: borrá la carpeta y quitá el dispositivo desde el teléfono.

**El teléfono tiene que estar vinculado, no encendido 24/7.** Con multi-device WhatsApp mantiene la sesión aunque el teléfono esté apagado, pero si pasan ~14 días sin que el teléfono se conecte, WhatsApp cierra los dispositivos vinculados.

**Los mensajes viejos solo aparecen si WhatsApp los manda.** El bridge no puede pedir historial arbitrario hacia atrás; guarda lo que llega en el sync inicial más todo lo nuevo desde que lo instalaste. Mientras más tiempo lo dejes corriendo, más completo queda.

## Troubleshooting

**Vinculación nueva se cae en loop con `statusCode: 428` / "Connection Terminated", y nunca llega a mostrar el QR.** No es tu red ni tu instalación: desde fines de junio 2026 WhatsApp empezó a rechazar el identificador de plataforma `Browsers.macOS('Desktop')` (y el equivalente en Windows) antes de completar el handshake — [bug conocido de Baileys](https://github.com/WhiskeySockets/Baileys/issues/2677). El fix es usar `Browsers.macOS('Chrome')` en vez de `'Desktop'` en `src/bridge/socket.ts` (ya aplicado en este repo). Si vuelve a pasar tras actualizar `baileys`, revisá si el issue de arriba tiene una solución más reciente.

## Qué falta (fase 2)

La base ya guarda lo necesario para todo esto:

- Búsqueda full-text sobre todo el historial (la tabla `messages_fts` ya se está poblando).
- Contactos y participantes de grupos como tools.
- Descarga de media (imágenes, audio, documentos) — el bridge ya guarda el payload cifrado de los mensajes con media.
- Escritura: enviar mensajes, marcar como leído, reaccionar. Requiere pensar bien la confirmación humana antes de que un agente mande algo en tu nombre.

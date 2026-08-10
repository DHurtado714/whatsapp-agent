#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { BRIDGE_URL } from '../shared/config.js'
import { bridgeGet } from './client.js'

// ---------------------------------------------------------------- tipos del bridge

type ChatView = {
  jid: string
  name: string
  is_group: number
  last_message_at: number | null
  unread_count: number
  archived: number
  pinned: number
  phone_number: string | null
  last_message_text: string | null
  message_count: number
}

type MessageView = {
  msg_id: string
  from_me: number
  sender_display: string | null
  timestamp: number
  kind: string | null
  text: string | null
  media_type: string | null
  filename: string | null
  quoted_id: string | null
}

// ---------------------------------------------------------------- helpers

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

function fmtDate(ms: number | null): string {
  if (!ms) return 'sin fecha'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function parseWhen(input?: string): number | null {
  if (!input) return null
  const trimmed = input.trim()
  const relative = /^(\d+)\s*([dhwm])$/i.exec(trimmed)
  if (relative) {
    const n = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const mult = unit === 'h' ? 3.6e6 : unit === 'd' ? 8.64e7 : unit === 'w' ? 6.048e8 : 2.592e9
    return Date.now() - n * mult
  }
  if (/^\d{10}$/.test(trimmed)) return Number(trimmed) * 1000
  if (/^\d{13}$/.test(trimmed)) return Number(trimmed)
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

function renderChats(chats: ChatView[]): string {
  if (chats.length === 0) return 'No hay chats que coincidan.'
  return chats
    .map((c) => {
      const tags: string[] = []
      if (c.is_group) tags.push('grupo')
      if (c.unread_count > 0) tags.push(`${c.unread_count} sin leer`)
      if (c.pinned) tags.push('fijado')
      if (c.archived) tags.push('archivado')
      const preview = c.last_message_text ? ` | ultimo: ${truncate(c.last_message_text, 90)}` : ''
      return (
        `- ${c.name}${tags.length ? ` [${tags.join(', ')}]` : ''}\n` +
        `  jid: ${c.jid}${c.phone_number ? ` | tel: +${c.phone_number}` : ''}\n` +
        `  actividad: ${fmtDate(c.last_message_at)} | ${c.message_count} mensajes guardados${preview}`
      )
    })
    .join('\n')
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : clean.slice(0, n - 1) + '…'
}

/** Acepta un JID exacto, o un nombre/numero que resolvemos contra los chats guardados. */
async function resolveChat(input: string): Promise<{ chat: ChatView } | { ambiguous: ChatView[] }> {
  if (input.includes('@')) {
    const { chat } = await bridgeGet<{ chat: ChatView | null }>('/chat', { jid: input })
    if (chat) return { chat }
  }
  const { chats } = await bridgeGet<{ chats: ChatView[] }>('/chats/search', { q: input, limit: 10 })
  if (chats.length === 1) return { chat: chats[0] }
  return { ambiguous: chats }
}

// ---------------------------------------------------------------- servidor

const server = new McpServer(
  { name: 'whatsapp', version: '0.1.0' },
  {
    instructions:
      'Acceso de SOLO LECTURA a la cuenta de WhatsApp del usuario a traves de un bridge local (Baileys). ' +
      'Usa list_chats para ver conversaciones recientes, search_chats para encontrar una por nombre o numero, ' +
      'y get_messages para leer el historial de una conversacion. ' +
      'get_messages acepta un nombre o numero directamente, no hace falta buscar el JID primero. ' +
      'Este servidor no puede enviar mensajes ni modificar nada.'
  }
)

server.registerTool(
  'whatsapp_status',
  {
    title: 'Estado de la conexion de WhatsApp',
    description:
      'Muestra si el bridge de WhatsApp esta conectado, con que cuenta, y cuantos chats y mensajes hay guardados localmente. ' +
      'Usalo primero si alguna otra herramienta devuelve resultados vacios o un error de conexion.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    try {
      const s = await bridgeGet<any>('/status')
      const lines = [
        `Conexion: ${s.connection}${s.registered ? '' : ' (sin vincular todavia)'}`,
        s.me ? `Cuenta: ${s.me.name ?? '(sin nombre)'} — ${s.me.id}` : 'Cuenta: no vinculada',
        `Guardado localmente: ${s.stored.chats} chats, ${s.stored.messages} mensajes, ${s.stored.contacts} contactos`,
        `Sync de historial: ${s.history_sync.complete ? 'completo' : 'en progreso'} (${s.history_sync.received} mensajes recibidos)`,
        s.connected_at ? `Conectado desde: ${fmtDate(s.connected_at)}` : null,
        s.awaiting_qr ? 'Esperando que escanees el QR en la terminal donde corre wa-bridge.' : null,
        s.pairing_code ? `Codigo de vinculacion pendiente: ${s.pairing_code}` : null,
        s.last_error ? `Ultimo error: ${s.last_error}` : null
      ].filter(Boolean)
      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
)

server.registerTool(
  'list_chats',
  {
    title: 'Listar chats de WhatsApp',
    description:
      'Lista las conversaciones de WhatsApp ordenadas por actividad reciente (fijadas primero). ' +
      'Devuelve el nombre, el JID (identificador que necesitas para get_messages), cuantos mensajes hay guardados ' +
      'y una vista previa del ultimo mensaje. Usa unread_only para ver solo lo pendiente.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(25).describe('Cuantos chats devolver (1-200).'),
      offset: z.number().int().min(0).default(0).describe('Cuantos chats saltar, para paginar.'),
      type: z
        .enum(['all', 'dm', 'group'])
        .default('all')
        .describe('Filtrar por tipo: all (todo), dm (conversaciones individuales), group (grupos).'),
      unread_only: z.boolean().default(false).describe('Solo chats con mensajes sin leer.'),
      include_archived: z.boolean().default(false).describe('Incluir chats archivados.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ limit, offset, type, unread_only, include_archived }) => {
    try {
      const { chats } = await bridgeGet<{ chats: ChatView[] }>('/chats', {
        limit,
        offset,
        type,
        unread_only,
        include_archived
      })
      return ok(`${chats.length} chats:\n\n${renderChats(chats)}`)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
)

server.registerTool(
  'search_chats',
  {
    title: 'Buscar un chat de WhatsApp',
    description:
      'Busca conversaciones por nombre de contacto, nombre de grupo o numero de telefono. ' +
      'Coincidencia parcial e insensible a mayusculas. Usalo cuando sepas con quien quieres hablar pero no el JID.',
    inputSchema: {
      query: z.string().min(1).describe('Nombre, parte del nombre, o numero de telefono a buscar.'),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximo de resultados.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ query, limit }) => {
    try {
      const { chats } = await bridgeGet<{ chats: ChatView[] }>('/chats/search', { q: query, limit })
      return ok(`${chats.length} coincidencias para "${query}":\n\n${renderChats(chats)}`)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
)

server.registerTool(
  'get_messages',
  {
    title: 'Leer mensajes de un chat',
    description:
      'Devuelve el historial de mensajes de una conversacion en orden cronologico. ' +
      'El parametro chat acepta un JID exacto, un nombre de contacto o grupo, o un numero de telefono. ' +
      'Usa since/until para acotar por fecha y limit + before para paginar hacia atras.',
    inputSchema: {
      chat: z.string().min(1).describe('JID (ej: 573001234567@s.whatsapp.net), nombre del contacto/grupo, o numero.'),
      limit: z.number().int().min(1).max(500).default(50).describe('Cuantos mensajes devolver (los mas recientes del rango).'),
      since: z
        .string()
        .optional()
        .describe('Solo mensajes posteriores a esta fecha. Acepta ISO 8601 ("2026-08-01") o relativo ("7d", "12h", "2w").'),
      until: z
        .string()
        .optional()
        .describe('Solo mensajes anteriores a esta fecha. Mismo formato que since. Usalo para paginar hacia atras.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ chat, limit, since, until }) => {
    try {
      const resolved = await resolveChat(chat)
      if ('ambiguous' in resolved) {
        if (resolved.ambiguous.length === 0) {
          return fail(
            `No encontre ningun chat que coincida con "${chat}". Proba con list_chats o search_chats para ver que hay disponible.`
          )
        }
        return ok(
          `"${chat}" coincide con varios chats. Volve a llamar get_messages con el jid exacto de uno:\n\n` +
            renderChats(resolved.ambiguous)
        )
      }

      const target = resolved.chat
      const { messages } = await bridgeGet<{ messages: MessageView[] }>('/messages', {
        chat_jid: target.jid,
        limit,
        after: parseWhen(since),
        before: parseWhen(until)
      })

      if (messages.length === 0) {
        return ok(
          `${target.name} (${target.jid}): no hay mensajes guardados en ese rango. ` +
            `El chat tiene ${target.message_count} mensajes en total. ` +
            `Si el numero es 0, puede que el sync de historial siga corriendo — revisa whatsapp_status.`
        )
      }

      const header =
        `${target.name} — ${target.is_group ? 'grupo' : 'conversacion individual'} (${target.jid})\n` +
        `${messages.length} mensajes, de ${fmtDate(messages[0].timestamp)} a ${fmtDate(messages[messages.length - 1].timestamp)}\n`

      const body = messages
        .map((m) => {
          const who = m.from_me ? 'yo' : (m.sender_display ?? 'desconocido')
          const media = m.media_type ? ` [${m.media_type}${m.filename ? `: ${m.filename}` : ''}]` : ''
          const reply = m.quoted_id ? ' (respuesta)' : ''
          return `[${fmtDate(m.timestamp)}] ${who}${reply}: ${m.text ?? ''}${media}`.trimEnd()
        })
        .join('\n')

      const footer =
        messages.length >= limit
          ? `\n\n(Hay mas mensajes. Para seguir hacia atras: get_messages con until="${new Date(messages[0].timestamp).toISOString()}")`
          : ''

      return ok(`${header}\n${body}${footer}`)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`wa-mcp listo (bridge: ${BRIDGE_URL})\n`)
}

main().catch((err) => {
  process.stderr.write(`wa-mcp fallo: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})

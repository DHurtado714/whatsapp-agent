import type { WAMessage } from 'baileys'
import { getContentType, normalizeMessageContent } from 'baileys'

export type ParsedMessage = {
  kind: string
  text: string | null
  mediaType: string | null
  filename: string | null
  quotedId: string | null
}

const MEDIA_KINDS: Record<string, string> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  ptvMessage: 'video_note'
}

/**
 * Extrae texto legible de un WAMessage. WhatsApp anida el contenido real dentro de
 * envolturas (ephemeral, viewOnce, documentWithCaption...), asi que primero
 * normalizamos y despues resolvemos por tipo.
 */
export function parseMessage(msg: WAMessage): ParsedMessage {
  const content = normalizeMessageContent(msg.message)
  if (!content) {
    return { kind: 'unknown', text: null, mediaType: null, filename: null, quotedId: null }
  }

  const type = getContentType(content) ?? 'unknown'
  const anyContent = content as Record<string, any>
  const node = anyContent[type] as Record<string, any> | undefined

  const quotedId: string | null = node?.contextInfo?.stanzaId ?? null
  const mediaType = MEDIA_KINDS[type] ?? null
  let text: string | null = null
  let filename: string | null = null

  switch (type) {
    case 'conversation':
      text = anyContent.conversation ?? null
      break
    case 'extendedTextMessage':
      text = node?.text ?? null
      break
    case 'imageMessage':
    case 'videoMessage':
    case 'ptvMessage':
      text = node?.caption ?? null
      break
    case 'documentMessage':
      filename = node?.fileName ?? null
      text = node?.caption ?? null
      break
    case 'audioMessage':
      text = node?.ptt ? '[nota de voz]' : '[audio]'
      break
    case 'stickerMessage':
      text = '[sticker]'
      break
    case 'locationMessage':
      text = `[ubicacion] ${node?.degreesLatitude ?? '?'},${node?.degreesLongitude ?? '?'}${
        node?.name ? ` (${node.name})` : ''
      }`
      break
    case 'liveLocationMessage':
      text = '[ubicacion en vivo]'
      break
    case 'contactMessage':
      text = `[contacto] ${node?.displayName ?? ''}`.trim()
      break
    case 'contactsArrayMessage':
      text = `[contactos] ${(node?.contacts ?? []).map((c: any) => c.displayName).join(', ')}`
      break
    case 'reactionMessage':
      text = `[reaccion] ${node?.text ?? ''}`.trim()
      break
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      text = `[encuesta] ${node?.name ?? ''}`.trim()
      break
    case 'buttonsResponseMessage':
      text = node?.selectedDisplayText ?? null
      break
    case 'listResponseMessage':
      text = node?.title ?? node?.singleSelectReply?.selectedRowId ?? null
      break
    case 'templateButtonReplyMessage':
      text = node?.selectedDisplayText ?? null
      break
    case 'protocolMessage':
      text = null
      break
    default:
      text = typeof node?.caption === 'string' ? node.caption : typeof node?.text === 'string' ? node.text : null
  }

  if (text) text = text.trim() || null

  return { kind: type, text, mediaType, filename, quotedId }
}

/** WhatsApp entrega timestamps en segundos, a veces como Long de protobufjs. */
export function toMillis(ts: unknown): number {
  if (ts === null || ts === undefined) return Date.now()
  const n =
    typeof ts === 'number'
      ? ts
      : typeof ts === 'string'
        ? Number(ts)
        : typeof ts === 'object' && ts !== null && 'toNumber' in (ts as any)
          ? (ts as any).toNumber()
          : Number(ts)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < 1e12 ? n * 1000 : n
}

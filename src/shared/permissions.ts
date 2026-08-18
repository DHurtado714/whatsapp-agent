/**
 * What the tool is allowed to *do*, as opposed to what it's allowed to read.
 *
 * Read access is unconditional — it's the baseline the tool has always had.
 * Every mutation goes through a named scope that must be granted explicitly,
 * and the default is no scopes at all, so an install that upgrades into this
 * version behaves exactly like the read-only versions before it until the
 * operator opts in.
 *
 * Resolved in two places on purpose:
 *   - the bridge owns the WhatsApp socket and is the real enforcer (403);
 *   - the MCP server resolves its own copy so it can avoid registering tools
 *     it isn't allowed to use, keeping the advertised tool list honest.
 * They read the same env vars, so they normally agree; when they don't, the
 * bridge wins and says so.
 */

export type Scope = 'send' | 'media' | 'chats' | 'groups'

export const ALL_SCOPES: readonly Scope[] = ['send', 'media', 'chats', 'groups']

export const SCOPE_HELP: Record<Scope, string> = {
  send: 'send, reply, react to, edit and delete messages',
  media: 'send images, video, audio and documents from local files or URLs',
  chats: 'mark chats read, archive, pin, mute, and send typing indicators',
  groups: 'create groups, add/remove/promote participants, rename, and leave',
}

export type Permissions = {
  scopes: Set<Scope>
  /** Allow writing to a JID that has no stored chat yet. Off by default: it's the guard against a hallucinated number. */
  allowNewContacts: boolean
  /** Validate and report what would happen, without touching the socket. */
  dryRun: boolean
  /** Outbound messages per minute. 0 disables the limit. */
  sendRateLimit: number
}

export type PermissionFlags = {
  allow?: string
  allowWrite?: boolean
  readOnly?: boolean
  allowNewContacts?: boolean
  dryRun?: boolean
  rateLimit?: number
}

export const DEFAULT_SEND_RATE_LIMIT = 10

export class PermissionConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionConfigError'
  }
}

/**
 * Parses a comma-separated scope list. 'all' expands to every scope, and the
 * empty string is a valid way to say "read-only". Anything unrecognised is a
 * hard error rather than a silent drop: a typo in WA_ALLOW would otherwise
 * quietly leave a capability off and look like a bug elsewhere.
 */
export function parseScopes(input: string): Set<Scope> {
  const parts = input
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')

  const scopes = new Set<Scope>()
  for (const part of parts) {
    if (part === 'all' || part === 'write') {
      for (const s of ALL_SCOPES) scopes.add(s)
      continue
    }
    if (part === 'none' || part === 'read' || part === 'readonly' || part === 'read-only') continue
    if (!(ALL_SCOPES as readonly string[]).includes(part)) {
      throw new PermissionConfigError(
        `unknown permission scope "${part}". Valid scopes: ${ALL_SCOPES.join(', ')} (or "all", or "none").`,
      )
    }
    scopes.add(part as Scope)
  }
  return scopes
}

function envFlag(name: string): boolean {
  const v = process.env[name]
  return v === 'true' || v === '1' || v === 'yes'
}

/**
 * Precedence, highest first: --read-only, then --allow/--allow-write, then
 * WA_ALLOW, then the read-only default.
 */
export function resolvePermissions(flags: PermissionFlags = {}): Permissions {
  let scopes: Set<Scope>
  if (flags.readOnly) {
    scopes = new Set()
  } else if (flags.allowWrite) {
    scopes = new Set(ALL_SCOPES)
  } else if (flags.allow !== undefined) {
    scopes = parseScopes(flags.allow)
  } else {
    scopes = parseScopes(process.env.WA_ALLOW ?? '')
  }

  const rateLimitEnv = process.env.WA_SEND_RATE_LIMIT
  let sendRateLimit = flags.rateLimit ?? (rateLimitEnv === undefined ? DEFAULT_SEND_RATE_LIMIT : Number(rateLimitEnv))
  if (!Number.isFinite(sendRateLimit) || sendRateLimit < 0) {
    throw new PermissionConfigError(
      `invalid send rate limit "${flags.rateLimit ?? rateLimitEnv}" — expected a number >= 0 (0 disables it).`,
    )
  }
  sendRateLimit = Math.floor(sendRateLimit)

  return {
    scopes,
    allowNewContacts: flags.allowNewContacts ?? envFlag('WA_ALLOW_NEW_CONTACTS'),
    dryRun: flags.dryRun ?? envFlag('WA_DRY_RUN'),
    sendRateLimit,
  }
}

export function hasScope(perms: Permissions, scope: Scope): boolean {
  return perms.scopes.has(scope)
}

export function isReadOnly(perms: Permissions): boolean {
  return perms.scopes.size === 0
}

/** Stable, sorted list — used in JSON payloads so tests and diffs don't depend on insertion order. */
export function scopeList(perms: Permissions): Scope[] {
  return ALL_SCOPES.filter((s) => perms.scopes.has(s))
}

/** One-line summary for `status`, `doctor` and the bridge's startup log. */
export function describePermissions(perms: Permissions): string {
  const granted = scopeList(perms)
  const base = granted.length === 0 ? 'read-only' : `read + ${granted.join(', ')}`
  const notes: string[] = []
  if (granted.length > 0) {
    if (perms.dryRun) notes.push('dry-run')
    if (perms.allowNewContacts) notes.push('new contacts allowed')
    notes.push(perms.sendRateLimit === 0 ? 'no rate limit' : `${perms.sendRateLimit}/min`)
  }
  return notes.length > 0 ? `${base} (${notes.join(', ')})` : base
}

/** Shape reported by GET /permissions and embedded in GET /status. */
export function permissionsPayload(perms: Permissions) {
  return {
    scopes: scopeList(perms),
    read_only: isReadOnly(perms),
    dry_run: perms.dryRun,
    allow_new_contacts: perms.allowNewContacts,
    send_rate_limit_per_minute: perms.sendRateLimit,
  }
}

// ---------------------------------------------------------------- tool inventory

/**
 * Which MCP tools exist at each permission level. src/mcp/index.ts registers
 * them with `if (can(scope))` blocks rather than from this table, so this is a
 * declaration of intent that something has to check — the e2e suite compares
 * the server's real tool list against expectedTools(), which is what stops the
 * two from drifting apart.
 */
export const READ_TOOLS: readonly string[] = ['whatsapp_status', 'list_chats', 'search_chats', 'get_messages']

export const WRITE_TOOLS: Record<Scope, readonly string[]> = {
  send: ['send_message', 'react_to_message', 'edit_message', 'delete_message'],
  media: ['send_media'],
  chats: ['mark_chat_read', 'update_chat', 'send_typing'],
  groups: ['create_group', 'manage_group_participants', 'update_group'],
}

/** Every tool name the MCP server should expose under these permissions, sorted. */
export function expectedTools(perms: Permissions): string[] {
  const names = [...READ_TOOLS]
  for (const scope of scopeList(perms)) names.push(...WRITE_TOOLS[scope])
  return names.sort()
}

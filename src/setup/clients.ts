import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type MergeOptions, type MergeResult, ensureJsonKey } from './jsonConfig.js'

export type McpServerEntry = {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type ClientTarget = {
  id: string
  label: string
  /** True if there's evidence this client is actually installed (config dir/file, or a CLI on PATH). */
  detected: boolean
  /**
   * Register the whatsapp MCP server with this client. Absent for clients
   * that only support copy-pasting a config snippet (no known safe way to
   * write their config, or it isn't a plain JSON file we can merge into).
   */
  register?: (entry: McpServerEntry, opts?: MergeOptions) => Promise<MergeResult>
  configPath?: string
}

function claudeDesktopConfigPath(): string {
  const platform = os.platform()
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  // Linux (no official Claude Desktop build, but community/Flatpak builds
  // follow the XDG convention).
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

function claudeCodeUserConfigPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

function cursorConfigPath(): string {
  return path.join(os.homedir(), '.cursor', 'mcp.json')
}

function windsurfConfigPath(): string {
  return path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')
}

async function fileExists(p: string): Promise<boolean> {
  return Bun.file(p).exists()
}

async function mergeMcpServers(configPath: string, entry: McpServerEntry, opts?: MergeOptions): Promise<MergeResult> {
  const current = await readJsonSafely(configPath)
  const existingServers =
    current && typeof current === 'object' && !Array.isArray(current)
      ? ((current as Record<string, unknown>).mcpServers as Record<string, unknown> | undefined)
      : undefined
  const desired = { ...(existingServers ?? {}), whatsapp: entry }
  return ensureJsonKey(configPath, 'mcpServers', desired, opts)
}

async function readJsonSafely(p: string): Promise<unknown> {
  try {
    const text = await Bun.file(p).text()
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Claude Code's `claude mcp add` defaults to --scope local, which writes
 * into `projects[cwd].mcpServers` — only active from the directory it was
 * run in. --scope user is what makes it available everywhere, which is what
 * an agent reading your WhatsApp from any project should be.
 */
async function registerClaudeCodeViaCli(entry: McpServerEntry): Promise<boolean> {
  const bin = Bun.which('claude')
  if (!bin) return false
  // `claude mcp add <name> [options] -- <command> [args...]`
  const args = ['mcp', 'add', 'whatsapp', '--scope', 'user']
  for (const [k, v] of Object.entries(entry.env ?? {})) args.push('-e', `${k}=${v}`)
  args.push('--', entry.command, ...entry.args)
  const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  return code === 0
}

/**
 * Enumerate the MCP client targets we know how to detect and register with.
 * `entry` is the MCP server definition to install (the resolved binary path
 * + `mcp` argument, optionally with a bridge auth token).
 */
export async function listClientTargets(): Promise<ClientTarget[]> {
  const claudeDesktopPath = claudeDesktopConfigPath()
  const claudeCodePath = claudeCodeUserConfigPath()
  const cursorPath = cursorConfigPath()
  const windsurfPath = windsurfConfigPath()

  const [claudeDesktopExists, claudeCodeExists, cursorDirExists, windsurfDirExists] = await Promise.all([
    fileExists(claudeDesktopPath),
    fileExists(claudeCodePath),
    fileExists(path.dirname(cursorPath)),
    fileExists(path.dirname(windsurfPath)),
  ])
  const claudeCliPresent = Boolean(Bun.which('claude'))

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      detected: claudeCliPresent || claudeCodeExists,
      configPath: claudeCodePath,
      register: async (entry, opts) => {
        if (claudeCliPresent && (await registerClaudeCodeViaCli(entry))) {
          return { status: 'updated', backupPath: '' } as MergeResult
        }
        // Fallback: merge directly into ~/.claude.json's top-level mcpServers
        // (user scope). This file also holds unrelated state (recent
        // projects, settings) — mergeMcpServers only ever touches the
        // mcpServers key.
        return mergeMcpServers(claudeCodePath, entry, opts)
      },
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      detected: claudeDesktopExists,
      configPath: claudeDesktopPath,
      register: (entry, opts) => mergeMcpServers(claudeDesktopPath, entry, opts),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      detected: cursorDirExists,
      configPath: cursorPath,
      register: (entry, opts) => mergeMcpServers(cursorPath, entry, opts),
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      detected: windsurfDirExists,
      configPath: windsurfPath,
      register: (entry, opts) => mergeMcpServers(windsurfPath, entry, opts),
    },
  ]
}

/** Universal fallback for any MCP client not in the list above. */
export function renderConfigSnippet(entry: McpServerEntry): string {
  return JSON.stringify({ mcpServers: { whatsapp: entry } }, null, 2)
}

export type RegisteredClient = { id: string; label: string; registered: boolean; commandExists?: boolean }

/**
 * Which MCP clients have a whatsapp entry, and whether its command still
 * exists on disk — catches "I moved/reinstalled the binary and forgot to
 * re-run setup" as a clear diagnosis instead of a silent tool failure.
 * Shared by `whatsapp-agent doctor` and the dashboard's GET /clients.
 */
export async function registeredClients(): Promise<RegisteredClient[]> {
  const targets = await listClientTargets()
  const clients: RegisteredClient[] = []
  for (const t of targets) {
    if (!t.configPath) continue
    const file = Bun.file(t.configPath)
    if (!(await file.exists())) continue
    try {
      const cfg = JSON.parse(await file.text())
      const entry = cfg?.mcpServers?.whatsapp
      if (entry?.command) {
        clients.push({ id: t.id, label: t.label, registered: true, commandExists: fs.existsSync(entry.command) })
      }
    } catch {
      /* unparseable config — not our concern here, jsonConfig.ts refuses to touch it */
    }
  }
  return clients
}

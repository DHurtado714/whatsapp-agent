import { type ClientTarget, type McpServerEntry, listClientTargets } from './clients.js'
import type { MergeOptions } from './jsonConfig.js'

/**
 * WA_ALLOW here is what makes the MCP server *advertise* the write tools.
 * The bridge enforces them regardless; this keeps the tool list honest.
 */
export function buildMcpEntry(o: { binPath: string; token: string; allow?: string }): McpServerEntry {
  return {
    command: o.binPath,
    args: ['mcp'],
    env: { WA_BRIDGE_TOKEN: o.token, ...(o.allow ? { WA_ALLOW: o.allow } : {}) },
  }
}

export type RegisterResult = {
  id: string
  label: string
  detected: boolean
  status?: 'created' | 'updated' | 'already-configured' | 'declined' | 'parse-error'
  backupPath?: string
  error?: string
}

/**
 * Registers `entry` with every detected MCP client. With no `opts` callbacks
 * (the GUI/headless path) ensureJsonKey merges non-interactively: refuses
 * unparseable JSON untouched, no-ops when already equal, and backs up before
 * any overwrite — see jsonConfig.ts. The interactive wizard passes its own
 * confirm() callbacks through `opts` so the prompts stay there and the
 * mechanics stay here, shared by both callers.
 */
export async function registerAllClients(
  entry: McpServerEntry,
  opts?: {
    confirmTarget?: (target: ClientTarget) => boolean
    confirmOverwrite?: MergeOptions['confirmChange']
  },
): Promise<{ results: RegisterResult[]; targets: ClientTarget[] }> {
  const targets = await listClientTargets()
  const results: RegisterResult[] = []

  for (const target of targets) {
    if (!target.detected || !target.register) {
      results.push({ id: target.id, label: target.label, detected: target.detected })
      continue
    }
    if (opts?.confirmTarget && !opts.confirmTarget(target)) {
      results.push({ id: target.id, label: target.label, detected: true, status: 'declined' })
      continue
    }
    const result = await target.register(entry, { confirmChange: opts?.confirmOverwrite })
    results.push({
      id: target.id,
      label: target.label,
      detected: true,
      status: result.status,
      backupPath: 'backupPath' in result ? result.backupPath : undefined,
      error: 'error' in result ? result.error : undefined,
    })
  }

  return { results, targets }
}

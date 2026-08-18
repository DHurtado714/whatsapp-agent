import path from 'node:path'

export type VerifyResult =
  | { ok: true; toolCount: number; connection: string; tools: string[] }
  | { ok: false; error: string }

/**
 * Spawns the real `mcp` subcommand as a separate process and drives it with
 * an actual MCP SDK client over stdio — the same thing an AI client will do
 * — rather than calling the server object in-process. This is deliberately
 * the same check used by both `setup`'s final step and the e2e suite, so
 * "the wizard says it's connected" and "the tests say it's connected" can
 * never silently drift apart.
 */
export async function verifyMcpEndToEnd(opts?: { command: string; args: string[] }): Promise<VerifyResult> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

  const spawn = opts ?? (await defaultSpawnTarget())
  const transport = new StdioClientTransport({
    command: spawn.command,
    args: spawn.args,
    env: process.env as Record<string, string>,
    stderr: 'ignore',
  })
  const client = new Client({ name: 'whatsapp-agent-setup', version: '1.0.0' })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    // Checked by name against the resolved permissions, not by count: the tool
    // list grows with every write scope granted, so a hardcoded number would
    // turn "the user enabled sending" into "setup verification failed".
    const { expectedTools, resolvePermissions } = await import('../shared/permissions.js')
    const expected = expectedTools(resolvePermissions())
    const actual = tools.tools.map((t) => t.name).sort()
    const missing = expected.filter((n) => !actual.includes(n))
    const unexpected = actual.filter((n) => !expected.includes(n))
    if (missing.length > 0 || unexpected.length > 0) {
      return {
        ok: false,
        error:
          `the tool list doesn't match the configured permissions` +
          `${missing.length ? ` — missing: ${missing.join(', ')}` : ''}` +
          `${unexpected.length ? ` — unexpected: ${unexpected.join(', ')}` : ''}`,
      }
    }
    const result = (await client.callTool({ name: 'whatsapp_status', arguments: {} })) as any
    const text = result.content?.map((c: any) => c.text).join('\n') ?? ''
    if (result.isError) {
      return { ok: false, error: text || 'whatsapp_status returned an error' }
    }
    const match = /Connection:\s*(\S+)/.exec(text)
    return { ok: true, toolCount: tools.tools.length, connection: match?.[1] ?? 'unknown', tools: actual }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await client.close().catch(() => {})
  }
}

async function defaultSpawnTarget(): Promise<{ command: string; args: string[] }> {
  try {
    const { resolveSelfPath } = await import('../service/index.js')
    return { command: resolveSelfPath(), args: ['mcp'] }
  } catch {
    // Not a compiled binary (local dev under `bun run`) — spawn the CLI
    // router from source instead.
    const cliPath = path.join(import.meta.dirname, '..', 'cli', 'index.ts')
    return { command: process.execPath, args: ['run', cliPath, 'mcp'] }
  }
}

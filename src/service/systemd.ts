import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SYSTEMD_UNIT_NAME = 'whatsapp-agent.service'

export type SystemdOptions = {
  binPath: string
  env?: Record<string, string>
}

export function renderSystemdUnit(opts: SystemdOptions): string {
  const envLines = Object.entries(opts.env ?? {})
    .map(([k, v]) => `Environment=${k}=${v.replace(/\n/g, ' ')}`)
    .join('\n')

  return `[Unit]
Description=WhatsApp Agent bridge (read-only WhatsApp -> SQLite -> MCP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${opts.binPath} bridge
Restart=always
RestartSec=5
${envLines}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`
}

export function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME)
}

/**
 * systemd --user units are killed when the last session for that user logs
 * out, unless linger is enabled — the single most common "it worked
 * yesterday" bug on a headless box. loginctl enable-linger usually works
 * unprivileged via polkit on a desktop session, but fails over plain SSH.
 */
export function hasSystemd(): boolean {
  return fs.existsSync(`/run/user/${process.getuid?.() ?? 0}/systemd`)
}

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

export async function lingerStatus(): Promise<boolean> {
  const user = os.userInfo().username
  const result = await run(['loginctl', 'show-user', user, '--property=Linger'])
  return result.stdout.includes('Linger=yes')
}

/** Returns true if linger ended up enabled (already was, or we just enabled it). */
export async function tryEnableLinger(): Promise<boolean> {
  if (await lingerStatus()) return true
  const user = os.userInfo().username
  const result = await run(['loginctl', 'enable-linger', user])
  if (result.code === 0) return true
  return false
}

/** Writes the unit file only — see writeLaunchdPlist for why this doesn't reload/restart the running job. */
export function writeSystemdUnit(opts: SystemdOptions): { unitPath: string } {
  const unitPath = systemdUnitPath()
  fs.mkdirSync(path.dirname(unitPath), { recursive: true })
  fs.writeFileSync(unitPath, renderSystemdUnit(opts))
  return { unitPath }
}

export async function installSystemdService(
  opts: SystemdOptions,
): Promise<{ unitPath: string; lingerEnabled: boolean }> {
  const { unitPath } = writeSystemdUnit(opts)

  await run(['systemctl', '--user', 'daemon-reload'])
  const enableResult = await run(['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT_NAME])
  if (enableResult.code !== 0) {
    throw new Error(`systemctl enable --now failed: ${enableResult.stderr || enableResult.stdout}`)
  }

  const lingerEnabled = await tryEnableLinger()
  return { unitPath, lingerEnabled }
}

export async function uninstallSystemdService(): Promise<void> {
  await run(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME])
  fs.rmSync(systemdUnitPath(), { force: true })
  await run(['systemctl', '--user', 'daemon-reload'])
}

export async function systemdServiceStatus(): Promise<{ installed: boolean; active: boolean; enabled: boolean }> {
  if (!fs.existsSync(systemdUnitPath())) return { installed: false, active: false, enabled: false }
  const [activeResult, enabledResult] = await Promise.all([
    run(['systemctl', '--user', 'is-active', SYSTEMD_UNIT_NAME]),
    run(['systemctl', '--user', 'is-enabled', SYSTEMD_UNIT_NAME]),
  ])
  return {
    installed: true,
    active: activeResult.stdout.trim() === 'active',
    enabled: enabledResult.stdout.trim() === 'enabled',
  }
}

export async function startSystemdService(): Promise<void> {
  await run(['systemctl', '--user', 'start', SYSTEMD_UNIT_NAME])
}

export async function stopSystemdService(): Promise<void> {
  await run(['systemctl', '--user', 'stop', SYSTEMD_UNIT_NAME])
}

export async function restartSystemdService(): Promise<void> {
  await run(['systemctl', '--user', 'restart', SYSTEMD_UNIT_NAME])
}

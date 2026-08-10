import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LAUNCHD_LABEL = 'io.github.whatsapp-agent.bridge'

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export type LaunchdOptions = {
  /** Absolute path to the whatsapp-agent binary. */
  binPath: string
  /** Where to write bridge.log (rotated by the bridge process itself, not launchd). */
  logPath: string
  env?: Record<string, string>
}

/**
 * A home directory (or any other interpolated string) containing `&`, `<`,
 * or `"` would otherwise silently produce a corrupt plist that launchd
 * rejects with an opaque error — every interpolated value here must be
 * escaped.
 */
export function renderLaunchdPlist(opts: LaunchdOptions): string {
  const envEntries = Object.entries(opts.env ?? {})
    .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(LAUNCHD_LABEL)}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(opts.binPath)}</string>
        <string>bridge</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`
}

export function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

function gui(): string {
  return `gui/${process.getuid?.() ?? 0}`
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

export async function installLaunchdService(opts: LaunchdOptions): Promise<{ plistPath: string }> {
  const plistPath = launchdPlistPath()
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true })
  fs.writeFileSync(plistPath, renderLaunchdPlist(opts))

  // bootstrap fails with "Load failed: 5: Input/output error" if the label
  // is already loaded — always bootout first, ignoring failure (it isn't
  // loaded on a first install).
  await run(['launchctl', 'bootout', gui(), plistPath])
  const result = await run(['launchctl', 'bootstrap', gui(), plistPath])
  if (result.code !== 0) {
    throw new Error(`launchctl bootstrap failed: ${result.stderr || result.stdout}`)
  }
  return { plistPath }
}

export async function uninstallLaunchdService(): Promise<void> {
  const plistPath = launchdPlistPath()
  await run(['launchctl', 'bootout', gui(), plistPath])
  fs.rmSync(plistPath, { force: true })
}

export async function launchdServiceStatus(): Promise<{ installed: boolean; running: boolean; raw: string }> {
  const plistPath = launchdPlistPath()
  if (!fs.existsSync(plistPath)) return { installed: false, running: false, raw: '' }
  const result = await run(['launchctl', 'print', `${gui()}/${LAUNCHD_LABEL}`])
  return {
    installed: true,
    running: result.code === 0 && /state = running/.test(result.stdout),
    raw: result.stdout,
  }
}

export async function startLaunchdService(): Promise<void> {
  const status = await launchdServiceStatus()
  if (!status.installed) throw new Error('service is not installed — run "service install" first')
  // bootstrap fails if already loaded; kickstart only works on an already-
  // loaded job. `stop` fully unloads (bootout), so after a stop this needs
  // to re-bootstrap, not kickstart.
  const result = await run(['launchctl', 'bootstrap', gui(), launchdPlistPath()])
  if (result.code !== 0 && !/already bootstrapped/i.test(result.stderr)) {
    // Already loaded (e.g. RunAtLoad kept it running) — just (re)start it.
    await run(['launchctl', 'kickstart', '-k', `${gui()}/${LAUNCHD_LABEL}`])
  }
}

export async function restartLaunchdService(): Promise<void> {
  await run(['launchctl', 'kickstart', '-k', `${gui()}/${LAUNCHD_LABEL}`])
}

export async function stopLaunchdService(): Promise<void> {
  await run(['launchctl', 'bootout', gui(), launchdPlistPath()])
}

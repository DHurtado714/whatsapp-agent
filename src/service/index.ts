import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  installLaunchdService,
  launchdServiceStatus,
  restartLaunchdService,
  startLaunchdService,
  stopLaunchdService,
  uninstallLaunchdService
} from './launchd.js'
import {
  hasSystemd,
  installSystemdService,
  restartSystemdService,
  startSystemdService,
  stopSystemdService,
  systemdServiceStatus,
  uninstallSystemdService
} from './systemd.js'

export type Platform = 'launchd' | 'systemd' | 'unsupported'

export function detectPlatform(): Platform {
  if (os.platform() === 'darwin') return 'launchd'
  if (os.platform() === 'linux') return hasSystemd() ? 'systemd' : 'unsupported'
  return 'unsupported'
}

/**
 * process.execPath is the actual running binary — for a compiled
 * `bun build --compile` executable that's the real path; for local dev
 * (`bun run src/cli/index.ts ...`) it's the bun runtime itself, which isn't
 * useful to point a service definition at. realpathSync additionally
 * resolves through a symlink (e.g. /usr/local/bin/whatsapp-agent ->
 * ~/.local/bin/whatsapp-agent-darwin-arm64) to the real file, since the
 * service definition needs a path that will still work if the symlink
 * target is what gets replaced on upgrade.
 */
export function resolveSelfPath(): string {
  const exe = process.execPath
  if (path.basename(exe).startsWith('bun') && !exe.includes('/$bunfs/')) {
    throw new Error(
      'Refusing to install a service pointing at the bun runtime itself. ' +
        'This only works from a compiled whatsapp-agent binary, not `bun run`.'
    )
  }
  try {
    return fs.realpathSync(exe)
  } catch {
    return exe
  }
}

function bridgeLogPath(): string {
  return path.join(os.homedir(), '.whatsapp-agent', 'logs', 'bridge.log')
}

export type ServiceInstallResult = {
  platform: Platform
  path: string
  lingerEnabled?: boolean
}

export async function installService(env: Record<string, string> = {}): Promise<ServiceInstallResult> {
  const platform = detectPlatform()
  const binPath = resolveSelfPath()
  if (platform === 'launchd') {
    const { plistPath } = await installLaunchdService({ binPath, logPath: bridgeLogPath(), env })
    return { platform, path: plistPath }
  }
  if (platform === 'systemd') {
    const { unitPath, lingerEnabled } = await installSystemdService({ binPath, env })
    return { platform, path: unitPath, lingerEnabled }
  }
  throw new Error(
    'No supported service manager found (launchd on macOS, systemd --user on Linux). ' +
      'Run "whatsapp-agent bridge" in a terminal you keep open, or use your own ' +
      'process manager (nohup, tmux, a cron @reboot line, ...).'
  )
}

export async function uninstallService(): Promise<void> {
  const platform = detectPlatform()
  if (platform === 'launchd') return uninstallLaunchdService()
  if (platform === 'systemd') return uninstallSystemdService()
  throw new Error('No service is installed on this platform.')
}

export async function serviceStatus(): Promise<{ platform: Platform; installed: boolean; running: boolean }> {
  const platform = detectPlatform()
  if (platform === 'launchd') {
    const s = await launchdServiceStatus()
    return { platform, installed: s.installed, running: s.running }
  }
  if (platform === 'systemd') {
    const s = await systemdServiceStatus()
    return { platform, installed: s.installed, running: s.active }
  }
  return { platform, installed: false, running: false }
}

export async function startService(): Promise<void> {
  const platform = detectPlatform()
  if (platform === 'launchd') return startLaunchdService()
  if (platform === 'systemd') return startSystemdService()
  throw new Error('No supported service manager found on this platform.')
}

export async function stopService(): Promise<void> {
  const platform = detectPlatform()
  if (platform === 'launchd') return stopLaunchdService()
  if (platform === 'systemd') return stopSystemdService()
  throw new Error('No supported service manager found on this platform.')
}

export async function restartService(): Promise<void> {
  const platform = detectPlatform()
  if (platform === 'launchd') return restartLaunchdService()
  if (platform === 'systemd') return restartSystemdService()
  throw new Error('No supported service manager found on this platform.')
}

/** Tail the bridge's own rotated log file (launchd/journald just capture the same stream). */
export async function* tailLogs(follow: boolean): AsyncGenerator<string> {
  const platform = detectPlatform()
  if (platform === 'systemd') {
    const args = follow ? ['--user', '-u', 'whatsapp-agent', '-f'] : ['--user', '-u', 'whatsapp-agent', '-n', '200']
    const proc = Bun.spawn(['journalctl', ...args], { stdout: 'pipe' })
    for await (const chunk of proc.stdout) yield Buffer.from(chunk).toString()
    return
  }

  const logPath = bridgeLogPath()
  if (!fs.existsSync(logPath)) {
    yield `No log file yet at ${logPath}.\n`
    return
  }
  const tail = Bun.spawn(follow ? ['tail', '-f', logPath] : ['tail', '-n', '200', logPath], { stdout: 'pipe' })
  for await (const chunk of tail.stdout) yield Buffer.from(chunk).toString()
}

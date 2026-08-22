export const APP_NAME = 'WhatsApp Agent'
export const APP_BUNDLE_ID = 'io.github.whatsapp-agent.app'
export const LAUNCHER_NAME = 'WhatsAppAgentLauncher'
export const INNER_BIN_NAME = 'whatsapp-agent'

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export type InfoPlistOptions = {
  version: string
  hasIcon: boolean
}

/**
 * No entitlements: nothing this app does (loopback networking, ~/ file
 * access, launching /usr/bin/open and osascript) needs any. No
 * NSAppleEventsUsageDescription either — the launcher never uses
 * `tell application "System Events"`, only `display dialog`, which targets
 * osascript itself and doesn't trip TCC.
 */
export function renderInfoPlist(opts: InfoPlistOptions): string {
  const iconEntry = opts.hasIcon ? '\n    <key>CFBundleIconFile</key>\n    <string>AppIcon</string>' : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>${xmlEscape(APP_BUNDLE_ID)}</string>
    <key>CFBundleExecutable</key>
    <string>${xmlEscape(LAUNCHER_NAME)}</string>
    <key>CFBundleName</key>
    <string>${xmlEscape(APP_NAME)}</string>
    <key>CFBundleDisplayName</key>
    <string>${xmlEscape(APP_NAME)}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${xmlEscape(opts.version)}</string>
    <key>CFBundleVersion</key>
    <string>${xmlEscape(opts.version)}</string>${iconEntry}
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
`
}

export type LauncherScriptOptions = {
  arch: 'arm64' | 'x64'
}

/**
 * CFBundleExecutable. All real logic lives in the `app` subcommand
 * (src/app/index.ts) — this only guards against the wrong-architecture
 * download, which would otherwise be a silent "Bad CPU type" with no window
 * and no Dock icon to explain it. An x64 build on Apple Silicon is allowed
 * (Rosetta handles it); only arm64-on-Intel is impossible, so the guard is
 * one-directional.
 */
export function renderLauncherScript(opts: LauncherScriptOptions): string {
  const archGuard =
    opts.arch === 'arm64'
      ? `if [ "$(uname -m)" != "arm64" ]; then
  osascript -e 'display alert "Wrong download" message "This is the Apple Silicon build. Download the Intel (x64) build instead."'
  exit 1
fi
`
      : ''

  return `#!/bin/sh
dir=$(dirname "$0")
${archGuard}exec "$dir/${INNER_BIN_NAME}" app
`
}

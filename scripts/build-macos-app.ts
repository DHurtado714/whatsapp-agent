#!/usr/bin/env bun
/**
 * Assembles the double-clickable macOS .app bundle and zips it for release.
 *
 * Usage:
 *   bun run scripts/build-macos-app.ts --arch=arm64
 *   bun run scripts/build-macos-app.ts --arch=x64
 *
 * Must run on macOS: codesigning has to happen natively (see
 * build-binaries.ts's header comment for why cross-compiled darwin
 * artifacts never get signed here).
 */
import fs from 'node:fs'
import path from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { APP_NAME, INNER_BIN_NAME, LAUNCHER_NAME, renderInfoPlist, renderLauncherScript } from '../src/app/bundle.js'
import { ALL_TARGETS, buildOne } from './build-binaries.js'

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function buildIcon(resourcesDir: string): Promise<boolean> {
  const iconPng = path.resolve('assets/icon.png')
  if (!(await Bun.file(iconPng).exists())) return false

  const iconsetDir = path.join(resourcesDir, 'AppIcon.iconset')
  fs.mkdirSync(iconsetDir, { recursive: true })
  const sizes = [16, 32, 64, 128, 256, 512, 1024]
  for (const size of sizes) {
    const base = size / 2
    if (base >= 16) {
      const r = await run([
        'sips',
        '-z',
        String(base),
        String(base),
        iconPng,
        '--out',
        path.join(iconsetDir, `icon_${base}x${base}.png`),
      ])
      if (r.code !== 0) throw new Error(`sips failed at ${base}x${base}: ${r.stderr}`)
    }
    const r2 = await run([
      'sips',
      '-z',
      String(size),
      String(size),
      iconPng,
      '--out',
      path.join(iconsetDir, `icon_${size / 2}x${size / 2}@2x.png`),
    ])
    if (r2.code !== 0) throw new Error(`sips failed at ${size}x${size}: ${r2.stderr}`)
  }
  const icnsPath = path.join(resourcesDir, 'AppIcon.icns')
  const iconutil = await run(['iconutil', '-c', 'icns', iconsetDir, '-o', icnsPath])
  if (iconutil.code !== 0) throw new Error(`iconutil failed: ${iconutil.stderr}`)
  fs.rmSync(iconsetDir, { recursive: true, force: true })
  return true
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('build-macos-app.ts must run on macOS (codesigning has to happen natively).')
  }

  const archArg = process.argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length)
  if (archArg !== 'arm64' && archArg !== 'x64') {
    throw new Error('Usage: bun run scripts/build-macos-app.ts --arch=arm64|x64')
  }
  const target = ALL_TARGETS.find((t) => t.os === 'darwin' && t.arch === archArg)
  if (!target) throw new Error(`No darwin target for arch ${archArg}`)

  const version: string = pkg.version
  const binDir = path.resolve('dist/bin')
  fs.mkdirSync(binDir, { recursive: true })
  const builtBinPath = await buildOne(target, binDir)

  const appDir = path.resolve('dist/app', `${APP_NAME}.app`)
  fs.rmSync(appDir, { recursive: true, force: true })
  const contentsDir = path.join(appDir, 'Contents')
  const macosDir = path.join(contentsDir, 'MacOS')
  const resourcesDir = path.join(contentsDir, 'Resources')
  fs.mkdirSync(macosDir, { recursive: true })
  fs.mkdirSync(resourcesDir, { recursive: true })

  console.log(`\n== assembling ${appDir} ==`)

  const hasIcon = await buildIcon(resourcesDir)
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), renderInfoPlist({ version, hasIcon }))
  fs.writeFileSync(path.join(contentsDir, 'PkgInfo'), 'APPL????')

  const launcherPath = path.join(macosDir, LAUNCHER_NAME)
  fs.writeFileSync(launcherPath, renderLauncherScript({ arch: archArg }))
  fs.chmodSync(launcherPath, 0o755)

  fs.copyFileSync(builtBinPath, path.join(macosDir, INNER_BIN_NAME))
  fs.chmodSync(path.join(macosDir, INNER_BIN_NAME), 0o755)

  const lint = await run(['plutil', '-lint', path.join(contentsDir, 'Info.plist')])
  if (lint.code !== 0) throw new Error(`plutil -lint failed:\n${lint.stderr || lint.stdout}`)
  console.log('  Info.plist: ok')

  // Sign last, once every byte is in place. No --deep (deprecated for
  // signing) — the nested binary is already ad-hoc signed by buildOne();
  // this seals the bundle root and the rest of its contents.
  const sign = await run(['codesign', '--force', '--sign', '-', '--timestamp=none', appDir])
  if (sign.code !== 0) throw new Error(`codesign failed for ${appDir}:\n${sign.stderr}`)
  const verify = await run(['codesign', '-vvv', '--strict', appDir])
  if (verify.code !== 0) throw new Error(`codesign verification failed for ${appDir}:\n${verify.stderr}`)
  console.log('  codesign: ok (ad-hoc)')

  // spctl will reject this — expected for an unsigned/ad-hoc app, not a build failure.
  const spctl = await run(['spctl', '-a', '-vv', appDir])
  console.log(
    `  spctl (informational, rejection expected): ${spctl.stderr.trim().split('\n')[0] || spctl.stdout.trim()}`,
  )

  const zipPath = path.resolve('dist/app', `WhatsApp-Agent-${version}-darwin-${archArg}.zip`)
  fs.rmSync(zipPath, { force: true })
  // ditto, not zip: zip can mangle the code signature on extraction.
  const ditto = await run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', appDir, zipPath])
  if (ditto.code !== 0) throw new Error(`ditto failed:\n${ditto.stderr}`)
  const { size } = fs.statSync(zipPath)
  console.log(`  zipped: ${zipPath} (${(size / 1e6).toFixed(1)} MB)`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

#!/usr/bin/env bun
/**
 * Builds standalone whatsapp-agent binaries with `bun build --compile`.
 *
 * Usage:
 *   bun run scripts/build-binaries.ts                    # every target
 *   bun run scripts/build-binaries.ts bun-darwin-arm64    # one or more specific targets
 *   bun run scripts/build-binaries.ts self                # only the target matching this host (CI smoke build)
 *
 * Don't cross-compile the macOS artifacts in CI — build them natively on a
 * macOS runner so codesigning happens on the same machine. Cross-compiling
 * from macOS to Linux is fine and is what this script is mainly for.
 */
import fs from 'node:fs'
import path from 'node:path'

export type TargetDef = { target: string; os: string; arch: string; darwin?: boolean }

export const ALL_TARGETS: TargetDef[] = [
  { target: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64', darwin: true },
  { target: 'bun-darwin-x64', os: 'darwin', arch: 'x64', darwin: true },
  { target: 'bun-linux-x64', os: 'linux', arch: 'x64' },
  { target: 'bun-linux-x64-baseline', os: 'linux', arch: 'x64-baseline' },
  { target: 'bun-linux-arm64', os: 'linux', arch: 'arm64' },
]

function selfTarget(): TargetDef {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const found = ALL_TARGETS.find((t) => t.os === os && t.arch === arch)
  if (!found) throw new Error(`No known target for ${os}/${arch}`)
  return found
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

export async function buildOne(def: TargetDef, outDir: string): Promise<string> {
  const outfile = path.join(outDir, `whatsapp-agent-${def.os}-${def.arch}`)
  console.log(`\n== ${def.target} -> ${outfile} ==`)

  const result = await run([
    'bun',
    'build',
    '--compile',
    `--target=${def.target}`,
    '--minify',
    '--sourcemap=none',
    `--outfile=${outfile}`,
    './src/cli/index.ts',
  ])
  if (result.code !== 0) {
    throw new Error(`bun build failed for ${def.target}:\n${result.stderr || result.stdout}`)
  }
  console.log(result.stdout.trim())

  if (def.darwin && process.platform === 'darwin') {
    // Ad-hoc sign so the binary executes at all on Apple Silicon (an
    // unsigned Mach-O gets silently killed), then verify — verifying is the
    // important half, it turns a bad build into a failed CI job instead of
    // a binary that ships broken.
    const sign = await run(['codesign', '--force', '--sign', '-', '--timestamp=none', outfile])
    if (sign.code !== 0) throw new Error(`codesign failed for ${outfile}:\n${sign.stderr}`)
    const verify = await run(['codesign', '-vvv', '--strict', outfile])
    if (verify.code !== 0) throw new Error(`codesign verification failed for ${outfile}:\n${verify.stderr}`)
    console.log('  codesign: ok')
  } else if (def.darwin) {
    console.log('  (skipping codesign — not running on macOS; do NOT ship this artifact from here)')
  }

  const { size } = fs.statSync(outfile)
  console.log(`  size: ${(size / 1e6).toFixed(1)} MB`)
  return outfile
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let targets: TargetDef[]
  if (args.length === 0) {
    targets = ALL_TARGETS
  } else if (args.length === 1 && args[0] === 'self') {
    targets = [selfTarget()]
  } else {
    targets = args.map((name) => {
      const found = ALL_TARGETS.find((t) => t.target === name)
      if (!found) throw new Error(`Unknown target "${name}". Known: ${ALL_TARGETS.map((t) => t.target).join(', ')}`)
      return found
    })
  }

  const outDir = path.resolve('dist/bin')
  fs.mkdirSync(outDir, { recursive: true })

  const built: string[] = []
  for (const def of targets) {
    built.push(await buildOne(def, outDir))
  }

  console.log(`\nBuilt ${built.length} binaries in ${outDir}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

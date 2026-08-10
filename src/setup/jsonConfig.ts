import fs from 'node:fs'
import path from 'node:path'

/**
 * Safely merge a single top-level key into a JSON config file that may
 * already contain a lot of unrelated user state (Claude Desktop's config has
 * a deep `preferences` tree; `~/.claude.json` has ~80 unrelated top-level
 * keys plus a `projects` map). This is the code most likely to ruin
 * someone's day if it's wrong, so the rules are deliberately conservative:
 *
 *   - Never overwrite a file that fails to parse as JSON. Abort instead.
 *   - Never write anything if the desired value is already there.
 *   - Always back up before changing an existing file.
 *   - Write via a temp file + rename in the same directory, so a crash
 *     mid-write can't leave a half-written config behind.
 *   - Re-read and re-parse after writing to confirm the write actually
 *     landed; restore the backup if it didn't.
 */

export type MergeResult =
  | { status: 'created' }
  | { status: 'already-configured' }
  | { status: 'updated'; backupPath: string }
  | { status: 'declined' }
  | { status: 'parse-error'; error: string }

export type MergeOptions = {
  /** File mode for newly created files. Defaults to 0o600 (both target configs contain no secrets today, but may in the future). */
  mode?: number
  /**
   * Called only when the file already exists AND the desired value differs
   * from what's currently there. Return false to skip this file entirely.
   * Omit (or always return true) to merge non-interactively.
   */
  confirmChange?: (current: unknown, desired: unknown) => boolean | Promise<boolean>
  /** How many rotated backups to keep. Defaults to 5. */
  maxBackups?: number
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  const aKeys = Object.keys(a as object)
  const bKeys = Object.keys(b as object)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => deepEqual((a as any)[k], (b as any)[k]))
}

function pruneBackups(filePath: string, keep: number): void {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  const backups = entries
    .filter((f) => f.startsWith(`${base}.bak-`))
    .sort() // ISO timestamps sort chronologically as strings
  const toDelete = backups.slice(0, Math.max(0, backups.length - keep))
  for (const f of toDelete) {
    try {
      fs.rmSync(path.join(dir, f), { force: true })
    } catch {
      /* best effort */
    }
  }
}

/**
 * Ensure `topLevelKey` in the JSON file at `filePath` deep-equals
 * `desiredValue`, merging into whatever else is already in the file.
 * `getRoot`/nothing else in the file is touched.
 */
export async function ensureJsonKey(
  filePath: string,
  topLevelKey: string,
  desiredValue: unknown,
  opts: MergeOptions = {}
): Promise<MergeResult> {
  const mode = opts.mode ?? 0o600
  const maxBackups = opts.maxBackups ?? 5

  let currentRoot: Record<string, unknown> | null = null
  let existingMode: number | null = null

  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf-8')
    try {
      currentRoot = raw.trim() === '' ? {} : JSON.parse(raw)
    } catch (err) {
      return { status: 'parse-error', error: err instanceof Error ? err.message : String(err) }
    }
    if (typeof currentRoot !== 'object' || currentRoot === null || Array.isArray(currentRoot)) {
      return { status: 'parse-error', error: 'top-level JSON value is not an object' }
    }
    existingMode = fs.statSync(filePath).mode & 0o777
  }

  const isNewFile = currentRoot === null
  const root: Record<string, unknown> = currentRoot ?? {}

  if (!isNewFile && deepEqual(root[topLevelKey], desiredValue)) {
    return { status: 'already-configured' }
  }

  if (!isNewFile && opts.confirmChange) {
    const proceed = await opts.confirmChange(root[topLevelKey], desiredValue)
    if (!proceed) return { status: 'declined' }
  }

  let backupPath = ''
  if (!isNewFile) {
    backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(filePath, backupPath)
    if (existingMode !== null) fs.chmodSync(backupPath, existingMode)
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }

  const newRoot = { ...root, [topLevelKey]: desiredValue }
  const serialized = `${JSON.stringify(newRoot, null, 2)}\n`

  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`)
  const fd = fs.openSync(tmpPath, 'w', existingMode ?? mode)
  try {
    fs.writeSync(fd, serialized)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)

  // Verify the write actually landed before declaring success.
  try {
    const verify = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    if (!deepEqual(verify[topLevelKey], desiredValue)) {
      throw new Error('post-write verification mismatch')
    }
  } catch (err) {
    if (!isNewFile && backupPath) {
      fs.copyFileSync(backupPath, filePath)
    }
    return {
      status: 'parse-error',
      error: `write verification failed, restored backup: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (!isNewFile) {
    pruneBackups(filePath, maxBackups)
    return { status: 'updated', backupPath }
  }
  return { status: 'created' }
}

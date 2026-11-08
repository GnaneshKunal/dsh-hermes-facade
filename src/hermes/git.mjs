/**
 * The in-chat Git surface on the Hermes listener, read-only.
 *
 * Hermex shows a Git menu for a chat whose folder is inside a repository. The
 * root comes from `GET /api/fs/git-root`, and every read names that root, so
 * the routes see paths above the chat folder. The chat folder (or an ancestor
 * that is the repository root) is what the shared fence admits; the commands
 * themselves run with `execFile` (no shell), a timeout, a bounded output buffer
 * and `GIT_OPTIONAL_LOCKS=0`, so a read never writes the index.
 *
 * Writes (stage/unstage/revert/commit/push, branch switch) are deliberately not
 * wired yet: the routes answer a refusal with a reason instead of touching the
 * user's tree. `ship-info` answers no pull request, and `gh-auth` says `gh` is
 * not used here.
 *
 * Paths in responses are relative to the repository root, as the host's routes
 * return them, and a credential file is filtered from the rows and refused by
 * the diff routes, like the Files guard.
 *
 * @module dsh-hermes-facade/src/hermes/git
 */

import { execFile } from 'node:child_process'
import { lstat, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { isSensitivePath } from './fence.mjs'

/** Deadline for one git read. */
const GIT_TIMEOUT_MS = 10_000
/** Deadline for one git write (commit hooks, push, branch switch). */
const GIT_WRITE_TIMEOUT_MS = 60_000
/** Largest git stdout a read may produce (a binary/heavy diff fails as too large). */
const GIT_MAX_BUFFER = 16 * 1024 * 1024
/** Cap on untracked files whose line count is added to the totals. */
const UNTRACKED_SCAN_CAP = 50
/** Largest untracked file whose line count is read. */
const UNTRACKED_MAX_BYTES = 1024 * 1024
/** Most rows a status/review read returns. */
const ROW_CAP = 500
/** Refs the routes accept (revisions, branch names); rejects options and globs. */
const REF_PATTERN = /^[A-Za-z0-9._/@^~{}-]+$/

/** Environment variables that could point git at another tree than the fenced one. */
const GIT_ENV_DENY = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

/**
 * The base environment for a git read: the host's own, minus any variable that
 * would redirect the work tree, with optional locks and prompts off.
 * @returns {object} environment.
 */
function gitEnv() {
  const env = { ...process.env }
  for (const name of GIT_ENV_DENY) delete env[name]
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_PAGER = 'cat'
  return env
}

/**
 * A refusal the HTTP layer answers with a status and a detail.
 */
export class GitRefusal extends Error {
  /**
   * @param {number} status HTTP status.
   * @param {string} detail message for the phone.
   */
  constructor(status, detail) {
    super(detail)
    this.status = status
    this.detail = detail
  }
}

/**
 * Run one git command.
 * @param {string} cwd repository root.
 * @param {string[]} args arguments.
 * @returns {Promise<{code: number, stdout: string, stderr: string, tooLarge: boolean}>} result.
 */
function runGit(cwd, args, options = {}) {
  return new Promise(done => {
    execFile('git', [
      '--no-pager',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=',
      ...args,
    ], {
      cwd,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv(),
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      done({
        code,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        tooLarge: error !== null && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      })
    })
  })
}

/**
 * Run one git read and answer its stdout, mapping a failure to a refusal.
 * @param {string} cwd repository root.
 * @param {string[]} args arguments.
 * @param {string} what operation name for the log/detail.
 * @returns {Promise<string>} stdout.
 */
async function gitOut(cwd, args, what) {
  const result = await runGit(cwd, args)
  if (result.tooLarge) throw new GitRefusal(413, 'Output too large')
  if (result.code !== 0) throw new GitRefusal(400, 'git ' + what + ' failed')
  return result.stdout
}

/**
 * Run one git write and answer its stdout, mapping a failure to a refusal.
 * @param {string} cwd repository root.
 * @param {string[]} args arguments.
 * @param {string} what operation name for the detail.
 * @returns {Promise<string>} stdout.
 */
async function gitWriteOut(cwd, args, what) {
  const result = await runGit(cwd, args, { timeout: GIT_WRITE_TIMEOUT_MS })
  if (result.tooLarge) throw new GitRefusal(413, 'Output too large')
  if (result.code !== 0) throw new GitRefusal(400, 'git ' + what + ' failed')
  return result.stdout
}
/**
 * Validate a revision operand so it cannot be read by git as an option.
 * A range like `HEAD~3..HEAD` is fine; a leading '-' (or a glob) is not.
 * @param {string|undefined} value revision.
 * @returns {string} the revision.
 */
export function safeRef(value) {
  const ref = String(value ?? '')
  if (ref.length === 0 || ref.length > 200 || !REF_PATTERN.test(ref) || ref.startsWith('-')) {
    throw new GitRefusal(400, 'invalid ref')
  }
  return ref
}

/**
 * The new path of a numstat rename record (`a => b`, `dir/{a => b}/f`).
 * @param {string} raw raw path.
 * @returns {string} the new path.
 */
function renamePath(raw) {
  const path = String(raw ?? '').trim()
  if (!path.includes(' => ')) return path
  const brace = path.indexOf('{')
  const close = path.indexOf('}', brace + 1)
  if (brace >= 0 && close > brace) {
    const inner = path.slice(brace + 1, close)
    const to = inner.split(' => ').pop() ?? ''
    return (path.slice(0, brace) + to + path.slice(close + 1)).replaceAll('//', '/')
  }
  return path.split(' => ').pop().trim()
}

/**
 * Parse `git diff --numstat` into path → [added, removed] (binary counts as 0).
 * @param {string} stdout numstat output.
 * @returns {Map<string, [number, number]>} counts.
 */
function parseNumstat(stdout) {
  const counts = new Map()
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0
    const removed = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0
    counts.set(renamePath(parts[2]), [added, removed])
  }
  return counts
}

/**
 * Read a small untracked file's line count.
 * @param {string} root repository root.
 * @param {string} relative path relative to root.
 * @returns {Promise<number>} insertions.
 */
async function untrackedLines(root, relative, guard) {
  try {
    const target = join(root, relative)
    const info = await lstat(target)
    if (info.isFile() !== true || info.isSymbolicLink() || info.size > UNTRACKED_MAX_BYTES) return 0
    const real = await realpath(target)
    if (real !== root && !real.startsWith(root + sep)) return 0
    if (guard !== undefined && await guard(real)) return 0
    const body = await readFile(real)
    if (body.includes(0)) return 0
    let lines = 0
    for (const byte of body) if (byte === 0x0a) lines += 1
    return body.length > 0 && body[body.length - 1] !== 0x0a ? lines + 1 : lines
  } catch {
    return 0
  }
}

/**
 * Whether a repository-relative path must stay out of the Git surface: a
 * credential file/directory, or a path under a directory the facade never
 * serves (the state dir, `$DSH_HOME`, `~/.ssh`, …).
 * @param {string} root repository root.
 * @param {string} relative path relative to the root.
 * @param {(path: string) => Promise<boolean>} [deny] deny-root check.
 * @returns {Promise<boolean>} hidden.
 */
async function isHiddenPath(root, relative, deny) {
  const target = join(root, relative)
  if (isSensitivePath(target)) return true
  return deny === undefined ? false : deny(target)
}

/**
 * Parse porcelain-v2 status output into entries and branch facts.
 * @param {string} stdout `git status --porcelain=v2 --branch -z` output.
 * @returns {{entries: object[], branch: string|null, detached: boolean, ahead: number, behind: number}} parsed.
 */
function parseStatus(stdout) {
  const entries = []
  let branch = null
  let detached = false
  let ahead = 0
  let behind = 0
  const records = stdout.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length === 0) continue
    if (record.startsWith('# ')) {
      const header = record.slice(2)
      if (header.startsWith('branch.head ')) {
        const head = header.slice('branch.head '.length)
        detached = head === '(detached)'
        branch = detached ? null : head
      } else if (header.startsWith('branch.ab ')) {
        for (const token of header.split(' ').slice(1)) {
          if (token.startsWith('+')) ahead = Number.parseInt(token.slice(1), 10) || 0
          else if (token.startsWith('-')) behind = Number.parseInt(token.slice(1), 10) || 0
        }
      }
      continue
    }
    const tag = record[0]
    if (tag === '?') {
      entries.push({ tag, xy: '??', path: record.slice(2), staged: false, unstaged: true, untracked: true, conflicted: false })
    } else if (tag === 'u') {
      const path = record.split(' ', 11)[10] ?? ''
      entries.push({ tag, xy: record.split(' ', 11)[1] ?? 'UU', path, staged: false, unstaged: false, untracked: false, conflicted: true })
    } else if (tag === '1' || tag === '2') {
      const parts = record.split(' ', tag === '1' ? 9 : 10)
      const xy = parts[1] ?? '..'
      const path = tag === '1' ? (parts[8] ?? '') : renamePath(parts[9] ?? '')
      // A rename/copy origin record is the next NUL record and names no other row.
      if (tag === '2') index += 1
      entries.push({
        tag,
        xy,
        path,
        staged: xy[0] !== '.',
        unstaged: (xy[1] ?? '.') !== '.',
        untracked: false,
        conflicted: false,
      })
    }
  }
  return { entries, branch, detached, ahead, behind }
}

/**
 * The status letter the client shows for one entry.
 * @param {object} entry parsed entry.
 * @returns {string} letter.
 */
function statusLetter(entry) {
  if (entry.tag === '?' || entry.tag === 'u') return entry.tag.toUpperCase()
  const code = entry.xy[0] !== '.' ? entry.xy[0] : (entry.xy[1] ?? '.')
  return (code === '.' ? 'M' : code).toUpperCase()
}

/**
 * The shared branch facts for a repository.
 * @param {string} root repository root.
 * @returns {Promise<{branch: string|null, detached: boolean, defaultBranch: string|null, base: string|null}>} facts.
 */
async function branchFacts(root) {
  const head = (await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
  const detached = head.length === 0
  let branch = detached ? null : head
  if (branch !== null && branch.length === 0) branch = null
  const originHead = (await runGit(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])).stdout.trim()
  let defaultBranch = null
  if (originHead.length > 0 && originHead !== 'origin/HEAD') defaultBranch = originHead.split('/').slice(1).join('/')
  if (defaultBranch === null) {
    for (const candidate of ['refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
      if ((await runGit(root, ['show-ref', '--verify', '--quiet', candidate])).code === 0) {
        defaultBranch = candidate.split('/').pop()
        break
      }
    }
  }
  // "All branch changes" is measured from the merge-base with the trunk.
  let base = null
  for (const ref of [originHead, 'origin/main', 'origin/master', 'main', 'master']) {
    if (typeof ref !== 'string' || ref.length === 0) continue
    const merged = (await runGit(root, ['merge-base', 'HEAD', ref])).stdout.trim()
    if (merged.length > 0) { base = merged; break }
  }
  return { branch, detached, defaultBranch, base }
}

/**
 * Resolve the repository root holding a folder (or the folder of a file).
 * @param {string} path absolute, already fenced path.
 * @returns {Promise<string|undefined>} real repository root.
 */
export async function findGitRoot(path) {
  let cwd = path
  try {
    const info = await stat(path)
    if (info.isDirectory() !== true) cwd = resolve(path, '..')
  } catch {
    return undefined
  }
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0) return undefined
  const root = result.stdout.trim()
  if (root.length === 0) return undefined
  try { return await realpath(root) } catch { return resolve(root) }
}

/**
 * Whether one more untracked file may be read for its line count.
 * @param {{count: number}} budget scan budget.
 * @returns {boolean} allowed.
 */
function mayScanUntracked(budget) {
  if (budget.count >= UNTRACKED_SCAN_CAP) return false
  budget.count += 1
  return true
}

/**
 * One row of a repository status.
 * @param {string} root repository root.
 * @param {object} entry parsed status entry.
 * @param {Map<string, [number, number]>} counts numstat for the whole change.
 * @param {boolean} scan whether an untracked file's lines may be read.
 * @returns {Promise<object>} row.
 */
async function statusRow(root, entry, counts, scan, guard) {
  const countsForFile = counts.get(entry.path) ?? [0, 0]
  const added = entry.untracked === true
    ? (scan ? await untrackedLines(root, entry.path, guard) : 0)
    : countsForFile[0]
  return {
    path: entry.path,
    status: statusLetter(entry),
    staged: entry.staged,
    unstaged: entry.unstaged,
    untracked: entry.untracked,
    conflicted: entry.conflicted,
    added,
    removed: entry.untracked === true ? 0 : countsForFile[1],
  }
}

/**
 * The compact status the Git menu shows.
 * @param {string} root repository root.
 * @returns {Promise<object|null>} status, null outside a repository.
 */
export async function repoStatus(root, guard) {
  // `-uall` names each untracked file; the default collapses a new directory to
  // one `dir/` row, which the one-file write guard then refuses.
  const result = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  if (result.code !== 0) return null
  const parsed = parseStatus(result.stdout)
  const counts = parseNumstat((await runGit(root, ['diff', '--numstat', 'HEAD'])).stdout)
  const visible = []
  for (const entry of parsed.entries) {
    if (visible.length >= ROW_CAP) break
    if (await isHiddenPath(root, entry.path, guard)) continue
    visible.push(entry)
  }
  const budget = { count: 0 }
  const files = []
  for (const entry of visible) {
    files.push(await statusRow(root, entry, counts, entry.untracked === true && mayScanUntracked(budget), guard))
  }
  const count = flag => files.filter(file => file[flag] === true).length
  const facts = await branchFacts(root)
  const totals = {
    changed: files.length,
    staged: count('staged'),
    unstaged: count('unstaged'),
    untracked: count('untracked'),
    conflicted: count('conflicted'),
    conflicts: count('conflicted'),
  }
  return {
    isGit: true,
    branch: facts.branch,
    defaultBranch: facts.defaultBranch,
    detached: facts.detached,
    ahead: parsed.ahead,
    behind: parsed.behind,
    ...totals,
    totals,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
    files,
  }
}

/**
 * Changed files for one review scope.
 * @param {string} root repository root.
 * @param {string} scope `uncommitted` | `branch` | `lastTurn`.
 * @param {string|undefined} base range base for `lastTurn`/`branch`.
 * @returns {Promise<{files: object[], base: string|null}>} list.
 */
export async function reviewList(root, scope, base, guard) {
  if (scope === 'branch' || scope === 'lastTurn') {
    const facts = await branchFacts(root)
    const from = scope === 'branch' ? facts.base : (base === undefined ? null : safeRef(base))
    if (from === null || from.length === 0) return { files: [], base: null }
    const range = scope === 'branch' ? from + '...HEAD' : from
    const counts = parseNumstat((await runGit(root, ['diff', '--numstat', range])).stdout)
    const rows = []
    for (const [path, [added, removed]] of counts) {
      if (await isHiddenPath(root, path, guard)) continue
      rows.push({ path, added, removed, status: 'M', staged: false })
    }
    if (scope === 'lastTurn') {
      const status = parseStatus((await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])).stdout)
      const seen = new Set(rows.map(row => row.path))
      const budget = { count: 0 }
      for (const entry of status.entries) {
        if (entry.untracked !== true || seen.has(entry.path)) continue
        if (await isHiddenPath(root, entry.path, guard)) continue
        const added = mayScanUntracked(budget) ? await untrackedLines(root, entry.path, guard) : 0
        rows.push({ path: entry.path, added, removed: 0, status: '?', staged: false })
      }
    }
    rows.sort((left, right) => left.path.localeCompare(right.path))
    return { files: rows.slice(0, ROW_CAP), base: from }
  }

  const parsed = parseStatus((await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])).stdout)
  const staged = parseNumstat((await runGit(root, ['diff', '--numstat', '--cached'])).stdout)
  const worktree = parseNumstat((await runGit(root, ['diff', '--numstat'])).stdout)
  const rows = []
  const budget = { count: 0 }
  for (const entry of parsed.entries) {
    if (await isHiddenPath(root, entry.path, guard)) continue
    const [stagedAdded, stagedRemoved] = staged.get(entry.path) ?? [0, 0]
    const [workAdded, workRemoved] = worktree.get(entry.path) ?? [0, 0]
    const added = entry.untracked === true
      ? (mayScanUntracked(budget) ? await untrackedLines(root, entry.path, guard) : 0)
      : stagedAdded + workAdded
    const removed = entry.untracked === true ? 0 : stagedRemoved + workRemoved
    rows.push({ path: entry.path, added, removed, status: statusLetter(entry), staged: entry.staged })
  }
  rows.sort((left, right) => left.path.localeCompare(right.path))
  return { files: rows.slice(0, ROW_CAP), base: null }
}

/**
 * The literal pathspec for one repository-relative file, after validating it.
 * @param {string} root repository root.
 * @param {string} file client path.
 * @returns {string} pathspec.
 */
export async function safeFilePath(root, file, deny) {
  // A caller may hand a symlinked repository path (macOS /var vs /private/var).
  const base = await realpath(root).catch(() => root)
  const value = String(file ?? '')
  if (value.length === 0) throw new GitRefusal(400, 'file required')
  if (value.startsWith('/') || value.includes('\0')) throw new GitRefusal(400, 'file must be relative')
  const target = resolve(join(base, value))
  if (target !== base && !target.startsWith(base + sep)) throw new GitRefusal(400, 'file must be inside the repository')
  if (isSensitivePath(target)) throw new GitRefusal(403, 'Access to sensitive files is not allowed')
  let info
  try { info = await lstat(target) } catch { info = undefined }
  // A symlink is the classic way out of a lexical fence; refuse it outright.
  if (info !== undefined && info.isSymbolicLink()) throw new GitRefusal(400, 'symlink paths are not served')
  // `:(literal)` stops globs but not subtree matching; every route is one file.
  if (info !== undefined && info.isDirectory()) throw new GitRefusal(400, 'file required, not a directory')
  if (value === '.git' || value.startsWith('.git/')) throw new GitRefusal(403, 'Access to repository internals is not allowed')
  let real = target
  if (info !== undefined) {
    real = await realpath(target)
    if (real !== base && !real.startsWith(base + sep)) {
      throw new GitRefusal(403, 'file must be inside the repository')
    }
    if (isSensitivePath(real)) throw new GitRefusal(403, 'Access to sensitive files is not allowed')
    if (deny !== undefined && await deny(real)) {
      throw new GitRefusal(403, 'Access to sensitive files is not allowed')
    }
  } else if (deny !== undefined && await deny(target)) {
    // A deleted file is a normal row; its path must still not name a secret tree.
    throw new GitRefusal(403, 'Access to sensitive files is not allowed')
  }
  return { literal: ':(literal)' + value, relative: value, target: real }
}

/**
 * The diff of one file, refusing a pathspec that expands to more than that file.
 * @param {string} root repository root.
 * @param {string[]} range diff range arguments.
 * @param {string} file relative path.
 * @param {string} literal pathspec.
 * @returns {Promise<string>} patch.
 */
async function singleFileDiff(root, range, file, literal) {
  const names = await gitOut(root, ['diff', ...range, '--no-renames', '--name-only', '-z', '--', literal], 'diff')
  const named = names.split('\0').filter(name => name.length > 0)
  if (named.length === 0) return ''
  // A literal pathspec still expands a directory; require exactly the one row.
  // Comparing the names also keeps a deleted file (no realpath) working.
  for (const name of named) {
    if (name !== file) throw new GitRefusal(400, 'Expected a single file, not a directory')
  }
  return gitOut(root, ['diff', '--no-ext-diff', '--no-textconv', ...range, '--no-renames', '--', literal], 'diff')
}

/**
 * An all-add patch for an untracked file (the `--no-index` form git uses).
 * @param {string} root repository root.
 * @param {string} file relative path.
 * @returns {Promise<string>} patch.
 */
async function allAddDiff(root, file) {
  // Only a real, regular file: --no-index follows a symlink, so never hand it one.
  let info
  try { info = await lstat(join(root, file)) } catch { return '' }
  if (info.isFile() !== true || info.isSymbolicLink()) return ''
  const result = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', file])
  if (result.tooLarge) throw new GitRefusal(413, 'Output too large')
  // --no-index exits 1 when the files differ, which is the normal case.
  return result.stdout
}

/**
 * The patch for one file in one review scope.
 * @param {string} root repository root.
 * @param {object} options options.
 * @param {string} options.file relative path.
 * @param {string} options.scope review scope.
 * @param {string|undefined} options.base range base.
 * @param {boolean} options.staged staged-only worktree read.
 * @returns {Promise<string>} patch.
 */
export async function reviewDiff(root, { file, scope, base, staged }, deny) {
  const { literal, relative } = await safeFilePath(root, file, deny)
  if (scope === 'branch') {
    const facts = await branchFacts(root)
    return facts.base === null ? '' : singleFileDiff(root, [facts.base + '...HEAD'], relative, literal)
  }
  if (scope === 'lastTurn') {
    if (base === undefined || base.length === 0) return ''
    return singleFileDiff(root, [safeRef(base)], relative, literal)
  }
  if (staged === true) return singleFileDiff(root, ['--cached'], relative, literal)
  const worktree = await singleFileDiff(root, [], relative, literal)
  if (worktree.trim().length > 0) return worktree
  // Only an untracked file gets the all-add fallback. An unchanged tracked file,
  // an ignored file, or .git/config must not become a whole-file read.
  const status = (await runGit(root, ['status', '--porcelain', '--', literal])).stdout.trimStart()
  return status.startsWith('??') ? allAddDiff(root, relative) : ''
}

/**
 * Working-tree-vs-HEAD patch for one file.
 * @param {string} root repository root.
 * @param {string} file relative path.
 * @returns {Promise<string>} patch.
 */
export async function fileDiff(root, file, deny) {
  const { literal, relative } = await safeFilePath(root, file, deny)
  const head = await singleFileDiff(root, ['HEAD'], relative, literal)
  if (head.trim().length > 0) return head
  const status = (await runGit(root, ['status', '--porcelain', '--', literal])).stdout
  return status.trimStart().startsWith('??') ? allAddDiff(root, relative) : ''
}

/**
 * Resolve a revision to a commit sha.
 * @param {string} root repository root.
 * @param {string|undefined} ref revision (HEAD by default).
 * @returns {Promise<string|null>} sha.
 */
export async function revParse(root, ref) {
  const value = typeof ref === 'string' && ref.length > 0 ? ref : 'HEAD'
  const result = await runGit(root, ['rev-parse', '--verify', '--quiet', safeRef(value)])
  if (result.code !== 0) return null
  const sha = result.stdout.trim()
  return sha.length > 0 ? sha : null
}

/**
 * The app prefixes a write's file with `:(literal)`; the path itself is what
 * safeFilePath validates. A raw path is accepted for other callers.
 * @param {string} file client file.
 * @returns {string} path.
 */
function clientFilePath(file) {
  const value = String(file ?? '')
  return value.startsWith(':(literal)') ? value.slice(':(literal)'.length) : value
}
/**
 * Require one path to name exactly one status entry (a deleted file has no
 * lstat). A directory/subtree is refused by safeFilePath before this.
 * @param {string} root repository root.
 * @param {string} literal literal pathspec.
 * @returns {Promise<string[]>} status records.
 */
async function singleStatusRecord(root, literal) {
  const output = (await runGit(root, ['status', '--porcelain=v2', '-z', '--', literal])).stdout
  const records = output.split('\0').filter(Boolean)
  if (records.length > 1) throw new GitRefusal(400, 'path does not name one file')
  return records
}

/**
 * Require one path to be a new/added entry before deleting it (never a tracked,
 * ignored or clean file).
 * @param {string} root repository root.
 * @param {string} literal literal pathspec.
 * @returns {Promise<void>} resolves when it is new.
 */
async function assertNewFile(root, literal) {
  const records = await singleStatusRecord(root, literal)
  if (records.length !== 1) throw new GitRefusal(409, 'path is not a new file')
  const record = records[0]
  const untracked = record.startsWith('? ')
  const added = record.startsWith('1 ') && record.slice(2, 4)[0] === 'A'
  if (!untracked && !added) throw new GitRefusal(409, 'path is not a new file')
}
/**
 * Stage one file (the app sends one request per file).
 * @param {string} root repository root.
 * @param {string} file repository-relative path.
 * @param {Function} [guard] deny predicate.
 * @returns {Promise<{file: string}>} staged file.
 */
export async function stageFile(root, file, guard) {
  const { literal, relative } = await safeFilePath(root, clientFilePath(file), guard)
  await singleStatusRecord(root, literal)
  const conflicts = (await runGit(root, ['diff', '--name-only', '--diff-filter=U', '--', literal])).stdout.trim()
  if (conflicts.length > 0) throw new GitRefusal(409, 'Resolve the conflict before staging this file')
  await gitWriteOut(root, ['add', '--', literal], 'add')
  return { file: relative }
}

/**
 * Unstage one file, or the whole index when no file is named.
 * @param {string} root repository root.
 * @param {string|undefined} file repository-relative path.
 * @param {Function} [guard] deny predicate.
 * @returns {Promise<{file: string|null}>} unstaged file/all.
 */
export async function unstageFile(root, file, guard) {
  const named = typeof file === 'string' && file.length > 0
  const literal = named ? (await safeFilePath(root, clientFilePath(file), guard)).literal : null
  if (literal !== null) await singleStatusRecord(root, literal)
  const pathspec = literal ?? '.'
  const result = await runGit(root, ['restore', '--staged', '--', pathspec])
  if (result.code !== 0) {
    // Unborn HEAD: restore cannot name a tree, but the index can still be reset.
    await gitWriteOut(root, ['rm', '-r', '--cached', '--ignore-unmatch', '--', pathspec], 'unstage')
  }
  return { file: named ? literal.slice(':(literal)'.length) : null }
}

/**
 * Return one file to HEAD. A tracked file is restored; a staged-new or
 * untracked file is removed. The app unstages a staged file before calling this.
 * @param {string} root repository root.
 * @param {string} file repository-relative path.
 * @param {Function} [guard] deny predicate.
 * @returns {Promise<{file: string}>} reverted file.
 */
export async function revertFile(root, file, guard) {
  const safe = await safeFilePath(root, clientFilePath(file), guard)
  await singleStatusRecord(root, safe.literal)
  const conflicts = (await runGit(root, ['diff', '--name-only', '--diff-filter=U', '--', safe.literal])).stdout.trim()
  if (conflicts.length > 0) throw new GitRefusal(409, 'Resolve the conflict before reverting this file')
  const atHead = (await runGit(root, ['ls-tree', '--name-only', 'HEAD', '--', safe.literal])).stdout.trim().length > 0
  if (atHead) {
    await gitWriteOut(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', safe.literal], 'revert')
    return { file: safe.relative }
  }
  // Not in HEAD: only a status row that is untracked/added may be deleted; an
  // ignored or clean file must never be removed. Drop the index entry first.
  await assertNewFile(root, safe.literal)
  await gitWriteOut(root, ['rm', '-r', '--cached', '--ignore-unmatch', '--', safe.literal], 'revert')
  const info = await lstat(safe.target).catch(() => undefined)
  if (info === undefined) return { file: safe.relative }
  if (info.isFile() !== true) throw new GitRefusal(400, 'Only a file can be reverted')
  await unlink(safe.target)
  return { file: safe.relative }
}

/**
 * Commit the staged index.
 * @param {string} root repository root.
 * @param {object} options options.
 * @param {string} options.message commit message.
 * @param {boolean} [options.push] push after committing.
 * @param {Function} [guard] deny predicate.
 * @returns {Promise<{ok: boolean, commit: string|null, status: object|null}>} commit result.
 */
export async function commitRepo(root, { message, push = false }, guard) {
  const text = String(message ?? '').trim()
  if (text.length === 0) throw new GitRefusal(400, 'commit message required')
  if (text.length > 5000) throw new GitRefusal(400, 'commit message is too long')
  const before = await repoStatus(root, guard)
  if (before === null) throw new GitRefusal(400, 'not a git repository')
  if ((before.conflicted ?? before.totals?.conflicts ?? 0) > 0) throw new GitRefusal(409, 'Resolve the conflicts before committing')
  if ((before.staged ?? 0) === 0) throw new GitRefusal(409, 'Nothing is staged to commit')
  await gitWriteOut(root, ['commit', '-m', text], 'commit')
  const sha = await revParse(root, 'HEAD')
  if (push === true) await pushRepo(root, guard)
  return { ok: true, commit: sha === null ? null : sha.slice(0, 7), status: await repoStatus(root, guard) }
}

/**
 * The push target configured for one local branch, in git's own order:
 * `branch.<name>.pushRemote`, then `remote.pushDefault`, then the branch's
 * `branch.<name>.remote`. The destination branch still comes from
 * `branch.<name>.merge`, so the refspec stays `<branch>:<upstream-branch>`.
 *
 * `@{u}` cannot be used here: its short form is `<remote>/<branch>` and a remote
 * name may itself contain `/` (`team/origin`), so splitting it at the first
 * slash names the wrong remote. The config keys keep the two halves apart.
 * `.` names the local repository and is not a push remote.
 *
 * @param {string} root repository root.
 * @param {string} branch local branch name.
 * @returns {Promise<{remote: string, branch: string}|null>} target, null when no push remote is configured.
 */
async function pushTarget(root, branch) {
  const read = async key => (await runGit(root, ['config', '--get', key])).stdout.trim()
  const [branchRemote, defaultRemote, upstreamRemote, merge] = await Promise.all([
    read('branch.' + branch + '.pushRemote'),
    read('remote.pushDefault'),
    read('branch.' + branch + '.remote'),
    read('branch.' + branch + '.merge'),
  ])
  const remote = [branchRemote, defaultRemote, upstreamRemote]
    .find(value => value.length > 0 && value !== '.')
  if (remote === undefined) return null
  // Config is hand-editable, and a value read as an option would change the
  // command (`git push --force …`); no legal remote name starts with '-'.
  if (remote.startsWith('-')) throw new GitRefusal(400, 'invalid push remote in git config')
  const prefix = 'refs/heads/'
  const upstream = merge.startsWith(prefix) && merge.length > prefix.length ? merge.slice(prefix.length) : null
  return { remote, branch: upstream ?? branch }
}

/**
 * Push the current branch to its configured upstream, or set origin as the
 * upstream when the branch has no push remote.
 * @param {string} root repository root.
 * @param {Function} [guard] deny predicate.
 * @returns {Promise<{ok: boolean, message: null, status: object|null}>} push result.
 */
export async function pushRepo(root, guard) {
  const before = await repoStatus(root, guard)
  if (before === null) throw new GitRefusal(400, 'not a git repository')
  if (before.detached === true) throw new GitRefusal(409, 'Cannot push a detached HEAD')
  const branch = before.branch
  if (typeof branch !== 'string' || branch.length === 0) throw new GitRefusal(409, 'No branch to push')
  const target = await pushTarget(root, branch)
  // Always an explicit refspec, so push.default never decides what is sent.
  // With no configured push remote, origin is the fallback and -u records it.
  const args = target === null
    ? ['push', '-u', 'origin', branch + ':' + branch]
    : ['push', target.remote, branch + ':' + target.branch]
  await gitWriteOut(root, args, 'push')
  return { ok: true, message: null, status: await repoStatus(root, guard) }
}

/**
 * Switch the working tree to an existing branch.
 * @param {string} root repository root.
 * @param {string} branch branch name.
 * @param {Function} [guard] deny predicate.
 * @returns {Promise<{ok: boolean, status: object|null, branches: object[]}>} switch result.
 */
export async function switchBranch(root, branch, guard) {
  const name = safeRef(branch)
  const result = await runGit(root, ['switch', name], { timeout: GIT_WRITE_TIMEOUT_MS })
  if (result.code !== 0) throw new GitRefusal(400, 'git switch failed')
  return { ok: true, status: await repoStatus(root, guard), branches: await branches(root) }
}

/**
 * The diff and recent subjects the app uses to suggest a commit message.
 * @param {string} root repository root.
 * @returns {Promise<{diff: string, recent: string, branch: string|null, truncated: boolean}>} context.
 */
export async function commitContext(root, deny) {
  const status = await repoStatus(root, deny)
  const names = (await gitOut(root, ['diff', '--cached', '--name-only', '-z'], 'diff')).split('\0').filter(Boolean)
  let full = ''
  for (const file of names) {
    try {
      const safe = await safeFilePath(root, file, deny)
      full += await gitOut(root, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--', safe.literal], 'diff')
    } catch (error) {
      // A staged credential is never sent to the message helper.
      if (!(error instanceof GitRefusal)) throw error
    }
    if (full.length >= 64 * 1024) break
  }
  const limit = 64 * 1024
  const recent = (await runGit(root, ['log', '-5', '--format=%s'])).stdout.trim()
  return {
    diff: full.slice(0, limit),
    recent,
    branch: status?.branch ?? null,
    truncated: full.length > limit,
  }
}
/**
 * Local heads first, then remote-tracking refs with no local head.
 * @param {string} root repository root.
 * @returns {Promise<object[]>} branches.
 */
export async function branches(root) {
  const localNames = (await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout
    .split('\n').map(name => name.trim()).filter(Boolean)
  if (localNames.length === 0) return []
  const remoteNames = (await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).stdout
    .split('\n').map(name => name.trim()).filter(Boolean)
  const locals = new Set(localNames)
  const facts = await branchFacts(root)
  const remoteShort = name => (name.includes('/') ? name.slice(name.indexOf('/') + 1) : name)
  const remotes = remoteNames.filter(name => !name.endsWith('/HEAD') && !locals.has(remoteShort(name)))
  const rows = localNames.map(name => ({
    name,
    checkedOut: name === facts.branch,
    isDefault: facts.defaultBranch !== null && name === facts.defaultBranch,
    isRemote: false,
    worktreePath: null,
  }))
  for (const name of remotes) {
    rows.push({ name, checkedOut: false, isDefault: false, isRemote: true, worktreePath: null })
  }
  return rows
}

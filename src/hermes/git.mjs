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
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { isSensitivePath } from './fence.mjs'

/** Deadline for one git read. */
const GIT_TIMEOUT_MS = 10_000
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
function runGit(cwd, args) {
  return new Promise(done => {
    execFile('git', [
      '--no-pager',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=',
      ...args,
    ], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
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
async function untrackedLines(root, relative) {
  try {
    const target = join(root, relative)
    const info = await stat(target)
    if (info.isFile() !== true || info.size > UNTRACKED_MAX_BYTES) return 0
    const body = await readFile(target)
    if (body.includes(0)) return 0
    let lines = 0
    for (const byte of body) if (byte === 0x0a) lines += 1
    return body.length > 0 && body[body.length - 1] !== 0x0a ? lines + 1 : lines
  } catch {
    return 0
  }
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
async function statusRow(root, entry, counts, scan) {
  const countsForFile = counts.get(entry.path) ?? [0, 0]
  const added = entry.untracked === true
    ? (scan ? await untrackedLines(root, entry.path) : 0)
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
export async function repoStatus(root) {
  const result = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z'])
  if (result.code !== 0) return null
  const parsed = parseStatus(result.stdout)
  const counts = parseNumstat((await runGit(root, ['diff', '--numstat', 'HEAD'])).stdout)
  const visible = parsed.entries.filter(entry => !isSensitivePath(join(root, entry.path))).slice(0, ROW_CAP)
  const budget = { count: 0 }
  const files = []
  for (const entry of visible) {
    files.push(await statusRow(root, entry, counts, entry.untracked === true && mayScanUntracked(budget)))
  }
  const count = flag => files.filter(file => file[flag] === true).length
  const facts = await branchFacts(root)
  return {
    branch: facts.branch,
    defaultBranch: facts.defaultBranch,
    detached: facts.detached,
    ahead: parsed.ahead,
    behind: parsed.behind,
    staged: count('staged'),
    unstaged: count('unstaged'),
    untracked: count('untracked'),
    conflicted: count('conflicted'),
    changed: files.length,
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
export async function reviewList(root, scope, base) {
  if (scope === 'branch' || scope === 'lastTurn') {
    const facts = await branchFacts(root)
    const from = scope === 'branch' ? facts.base : (base ?? null)
    if (from === null || from.length === 0) return { files: [], base: null }
    const range = scope === 'branch' ? from + '...HEAD' : from
    const counts = parseNumstat((await runGit(root, ['diff', '--numstat', range])).stdout)
    const rows = []
    for (const [path, [added, removed]] of counts) {
      if (isSensitivePath(join(root, path))) continue
      rows.push({ path, added, removed, status: 'M', staged: false })
    }
    if (scope === 'lastTurn') {
      const status = parseStatus((await runGit(root, ['status', '--porcelain=v2', '-z'])).stdout)
      const seen = new Set(rows.map(row => row.path))
      const budget = { count: 0 }
      for (const entry of status.entries) {
        if (entry.untracked !== true || seen.has(entry.path)) continue
        if (isSensitivePath(join(root, entry.path))) continue
        const added = mayScanUntracked(budget) ? await untrackedLines(root, entry.path) : 0
        rows.push({ path: entry.path, added, removed: 0, status: '?', staged: false })
      }
    }
    rows.sort((left, right) => left.path.localeCompare(right.path))
    return { files: rows.slice(0, ROW_CAP), base: from }
  }

  const parsed = parseStatus((await runGit(root, ['status', '--porcelain=v2', '-z'])).stdout)
  const staged = parseNumstat((await runGit(root, ['diff', '--numstat', '--cached'])).stdout)
  const worktree = parseNumstat((await runGit(root, ['diff', '--numstat'])).stdout)
  const rows = []
  const budget = { count: 0 }
  for (const entry of parsed.entries) {
    if (isSensitivePath(join(root, entry.path))) continue
    const [stagedAdded, stagedRemoved] = staged.get(entry.path) ?? [0, 0]
    const [workAdded, workRemoved] = worktree.get(entry.path) ?? [0, 0]
    const added = entry.untracked === true
      ? (mayScanUntracked(budget) ? await untrackedLines(root, entry.path) : 0)
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
export function safeFilePath(root, file) {
  const value = String(file ?? '')
  if (value.length === 0) throw new GitRefusal(400, 'file required')
  if (value.startsWith('/') || value.includes('\0')) throw new GitRefusal(400, 'file must be relative')
  const target = resolve(join(root, value))
  if (target !== root && !target.startsWith(root + sep)) throw new GitRefusal(400, 'file must be inside the repository')
  if (isSensitivePath(target)) throw new GitRefusal(403, 'Access to sensitive files is not allowed')
  return ':(literal)' + value
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
  let target
  try { target = await realpath(join(root, file)) } catch { target = undefined }
  for (const name of named) {
    let resolvedName
    try { resolvedName = await realpath(join(root, name)) } catch { resolvedName = undefined }
    if (target === undefined || resolvedName !== target) throw new GitRefusal(400, 'Expected a single file, not a directory')
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
  const result = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file])
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
export async function reviewDiff(root, { file, scope, base, staged }) {
  const literal = safeFilePath(root, file)
  if (scope === 'branch') {
    const facts = await branchFacts(root)
    return facts.base === null ? '' : singleFileDiff(root, [facts.base + '...HEAD'], file, literal)
  }
  if (scope === 'lastTurn') {
    return base === undefined || base.length === 0 ? '' : singleFileDiff(root, [base], file, literal)
  }
  if (staged === true) return singleFileDiff(root, ['--cached'], file, literal)
  const worktree = await singleFileDiff(root, [], file, literal)
  if (worktree.trim().length > 0) return worktree
  return allAddDiff(root, file)
}

/**
 * Working-tree-vs-HEAD patch for one file.
 * @param {string} root repository root.
 * @param {string} file relative path.
 * @returns {Promise<string>} patch.
 */
export async function fileDiff(root, file) {
  const literal = safeFilePath(root, file)
  const head = await singleFileDiff(root, ['HEAD'], file, literal)
  if (head.trim().length > 0) return head
  const status = (await runGit(root, ['status', '--porcelain', '--', literal])).stdout
  return status.trimStart().startsWith('??') ? allAddDiff(root, file) : ''
}

/**
 * Resolve a revision to a commit sha.
 * @param {string} root repository root.
 * @param {string|undefined} ref revision (HEAD by default).
 * @returns {Promise<string|null>} sha.
 */
export async function revParse(root, ref) {
  const value = typeof ref === 'string' && ref.length > 0 ? ref : 'HEAD'
  if (!REF_PATTERN.test(value) || value.startsWith('-')) throw new GitRefusal(400, 'invalid ref')
  const result = await runGit(root, ['rev-parse', '--verify', '--quiet', value])
  if (result.code !== 0) return null
  const sha = result.stdout.trim()
  return sha.length > 0 ? sha : null
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

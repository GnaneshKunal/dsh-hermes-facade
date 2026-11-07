import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  commitContext,
  commitRepo,
  pushRepo,
  repoStatus,
  revertFile,
  stageFile,
  switchBranch,
  unstageFile,
} from '../src/hermes/git.mjs'

const IDENTITY = ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false']

/**
 * Run one git command in a test repository.
 * @param {string} cwd repository.
 * @param {string[]} args arguments.
 * @returns {string} stdout.
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/**
 * A repository with one commit and a clean tree.
 * @returns {string} root.
 */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-git-write-'))
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(join(root, 'a.txt'), 'one\n')
  git(root, ['add', '.'])
  git(root, [...IDENTITY, 'commit', '-qm', 'initial'])
  return root
}

test('stage and unstage one file, including the client literal prefix', async () => {
  const root = repository()
  try {
    writeFileSync(join(root, 'a.txt'), 'two\n')
    await stageFile(root, ':(literal)a.txt')
    let status = await repoStatus(root)
    assert.equal(status.staged, 1)
    assert.equal(status.files[0].path, 'a.txt')
    await unstageFile(root, 'a.txt')
    status = await repoStatus(root)
    assert.equal(status.staged, 0)
    assert.equal(status.unstaged, 1)

    writeFileSync(join(root, 'b.txt'), 'new\n')
    await stageFile(root, 'b.txt')
    await unstageFile(root, undefined)
    status = await repoStatus(root)
    assert.equal(status.staged, 0)
    assert.equal(status.untracked, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('commit writes a short sha and clears the index', async () => {
  const root = repository()
  try {
    writeFileSync(join(root, 'a.txt'), 'two\n')
    await stageFile(root, 'a.txt')
    const result = await commitRepo(root, { message: 'change a' })
    assert.equal(result.ok, true)
    assert.match(result.commit, /^[0-9a-f]{7}$/)
    assert.equal(result.status.staged, 0)
    assert.equal(git(root, ['log', '-1', '--format=%s']).trim(), 'change a')
    await assert.rejects(() => commitRepo(root, { message: 'nothing' }), error => error.status === 409)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('revert restores a tracked file and removes a new one', async () => {
  const root = repository()
  try {
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    await revertFile(root, 'a.txt')
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\n')

    writeFileSync(join(root, 'new.txt'), 'new\n')
    await revertFile(root, 'new.txt')
    assert.equal(existsSync(join(root, 'new.txt')), false)

    writeFileSync(join(root, 'staged.txt'), 'staged\n')
    await stageFile(root, 'staged.txt')
    await revertFile(root, 'staged.txt')
    assert.equal(existsSync(join(root, 'staged.txt')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('push sets origin as the upstream and sends the new commit', async () => {
  const root = repository()
  const remote = mkdtempSync(join(tmpdir(), 'hermes-git-remote-'))
  try {
    git(remote, ['init', '-q', '--bare'])
    git(root, ['remote', 'add', 'origin', remote])
    const first = await pushRepo(root)
    assert.equal(first.ok, true)
    assert.equal(git(remote, ['rev-parse', 'main']).trim(), git(root, ['rev-parse', 'main']).trim())

    writeFileSync(join(root, 'b.txt'), 'two\n')
    await stageFile(root, 'b.txt')
    await commitRepo(root, { message: 'add b' })
    await pushRepo(root)
    assert.equal(git(remote, ['rev-parse', 'main']).trim(), git(root, ['rev-parse', 'main']).trim())
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('switchBranch moves the working tree and commitContext reports the staged diff', async () => {
  const root = repository()
  try {
    git(root, ['branch', 'feature'])
    const switched = await switchBranch(root, 'feature')
    assert.equal(switched.ok, true)
    assert.equal(switched.status.branch, 'feature')
    assert.ok(switched.branches.some(row => row.name === 'feature'))

    writeFileSync(join(root, 'a.txt'), 'staged\n')
    await stageFile(root, 'a.txt')
    const context = await commitContext(root)
    assert.match(context.diff, /staged/)
    assert.equal(context.branch, 'feature')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

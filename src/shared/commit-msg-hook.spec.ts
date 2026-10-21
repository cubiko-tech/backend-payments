// Red when scripts/commit-msg.sh drops the Refs check, the wip/ exception, or RXDEV-<n>/PAYL-<n> on line/payments.
import { spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

describe('scripts/commit-msg.sh hook', () => {
  const repoRoot = resolve(__dirname, '../..')
  const scriptPath = join(repoRoot, 'scripts/commit-msg.sh')
  const huskyHookPath = join(repoRoot, '.husky/commit-msg')
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'commit-msg-spec-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function runHook(message: string, branch = 'feat/RXDEV-1-x') {
    // Stub git: the service container lacks git and cases must exercise branch rules without switching HEAD (R17).
    const gitBin = join(tempDir, 'git')
    const escapedBranch = branch.replace(/'/g, "'\\''")
    writeFileSync(
      gitBin,
      [
        '#!/usr/bin/env bash',
        'if [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then',
        `  printf '%s\\n' '${escapedBranch}'`,
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
    )
    chmodSync(gitBin, 0o755)

    const msgFile = join(tempDir, 'COMMIT_EDITMSG')
    writeFileSync(msgFile, message)

    const result = spawnSync('bash', [scriptPath, msgFile], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ''}`,
      },
    })

    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    }
  }

  it('wires .husky/commit-msg to scripts/commit-msg.sh', () => {
    const content = readFileSync(huskyHookPath, 'utf8')
    expect(content).toContain('bash scripts/commit-msg.sh "$1"')
  })

  it('rejects a commit message without Refs: on a feature branch', () => {
    const res = runHook('feat(wallet): add x\n', 'feat/RXDEV-1-x')
    expect(res.status).toBe(1)
    expect(res.output).toContain('Refs:')
  })

  it('accepts a commit message with Refs: RXDEV-<n> on a feature branch', () => {
    const res = runHook('feat(wallet): add x\n\nRefs: RXDEV-1\n', 'feat/RXDEV-1-x')
    expect(res.status).toBe(0)
  })

  it('accepts a commit message with Refs: PAYL-<n> on line/payments', () => {
    const res = runHook('feat(wallet): add x\n\nRefs: PAYL-1\n', 'line/payments')
    expect(res.status).toBe(0)
  })

  it('accepts a commit message with Refs: RXDEV-<n> on line/payments', () => {
    const res = runHook('feat(wallet): add x\n\nRefs: RXDEV-1\n', 'line/payments')
    expect(res.status).toBe(0)
  })

  it('rejects Refs: PAYL-<n> outside line/payments', () => {
    const res = runHook('feat(wallet): add x\n\nRefs: PAYL-1\n', 'feat/RXDEV-1-x')
    expect(res.status).toBe(1)
    expect(res.output).toContain('Refs:')
  })

  it('accepts a commit message without Refs: on a wip/ branch', () => {
    const wipSubject = runHook('wip: x\n', 'wip/x')
    expect(wipSubject.status).toBe(0)

    const conventionalOnWip = runHook('feat(wallet): add x\n', 'wip/x')
    expect(conventionalOnWip.status).toBe(0)
  })

  it('rejects a subject outside Conventional Commits', () => {
    const res = runHook('add wallet feature\n\nRefs: RXDEV-1\n', 'feat/RXDEV-1-x')
    expect(res.status).toBe(1)
    expect(res.output).toContain('Conventional Commits')

    const wipOutsideWipBranch = runHook('wip: x\n\nRefs: RXDEV-1\n', 'feat/RXDEV-1-x')
    expect(wipOutsideWipBranch.status).toBe(1)
    expect(wipOutsideWipBranch.output).toContain('Conventional Commits')
  })

  it('rejects a subject longer than 72 characters', () => {
    const longSubject = `feat(wallet): ${'a'.repeat(59)}`
    expect(longSubject.length).toBe(73)

    const res = runHook(`${longSubject}\n\nRefs: RXDEV-1\n`, 'feat/RXDEV-1-x')
    expect(res.status).toBe(1)
    expect(res.output).toContain('73 chars (max 72)')
  })

  it('rejects a commit message with an AI Co-authored-by trailer', () => {
    const res = runHook(
      'feat(wallet): add x\n\nRefs: RXDEV-1\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      'feat/RXDEV-1-x',
    )
    expect(res.status).toBe(1)
    expect(res.output).toContain('Co-authored-by')
  })

  it('rejects a commit message with a Generated with AI signature', () => {
    const plain = runHook(
      [
        'feat(wallet): add x',
        '',
        'Refs: RXDEV-1',
        '',
        'Generated with [Claude Code](https://claude.com/claude-code)',
        '',
      ].join('\n'),
      'feat/RXDEV-1-x',
    )
    expect(plain.status).toBe(1)
    expect(plain.output).toContain('Generated with')

    const withIcon = runHook(
      [
        'feat(wallet): add x',
        '',
        'Refs: RXDEV-1',
        '',
        '\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)',
        '',
      ].join('\n'),
      'feat/RXDEV-1-x',
    )
    expect(withIcon.status).toBe(1)
    expect(withIcon.output).toContain('Generated with')
  })

  it('accepts prose containing "generated with" when it is not an AI signature', () => {
    const res = runHook(
      'build(db): add migration\n\nMigration generated with typeorm.\n\nRefs: PAYL-1\n',
      'line/payments',
    )
    expect(res.status).toBe(0)
  })

  it('strips comment lines and git commit -v diff below the scissors line before checking', () => {
    const refsOnlyBelowScissors = runHook(
      [
        'feat(wallet): add x',
        '',
        '# ------------------------ >8 ------------------------',
        'diff --git a/src/a.ts b/src/a.ts',
        'Refs: RXDEV-1',
        '',
      ].join('\n'),
      'feat/RXDEV-1-x',
    )
    expect(refsOnlyBelowScissors.status).toBe(1)
    expect(refsOnlyBelowScissors.output).toContain('Refs:')

    const commentLinesAndDiffWithAi = runHook(
      [
        '# Please enter the commit message for your changes.',
        'feat(wallet): add x',
        '',
        'Refs: RXDEV-1',
        '# Generated with [Claude Code](https://claude.com/claude-code)',
        '# ------------------------ >8 ------------------------',
        'diff --git a/src/a.ts b/src/a.ts',
        'Generated with [Claude Code](https://claude.com/claude-code)',
        'Co-Authored-By: Claude <noreply@anthropic.com>',
        '',
      ].join('\n'),
      'feat/RXDEV-1-x',
    )
    expect(commentLinesAndDiffWithAi.status).toBe(0)
  })

  it('bypasses format and Refs checks only for Git-generated Merge and Revert subjects without AI signatures', () => {
    expect(runHook("Merge branch 'develop'\n", 'feat/RXDEV-1-x').status).toBe(0)
    expect(runHook("Merge branch 'develop' into line/payments\n", 'line/payments').status).toBe(0)
    expect(
      runHook("Merge branches 'feat/a' and 'feat/b' into line/payments\n", 'line/payments').status,
    ).toBe(0)
    expect(
      runHook(
        'Merge pull request #43 from cubiko-tech/feat/RXDEV-12-plan-currency-by-country\n',
        'feat/RXDEV-1-x',
      ).status,
    ).toBe(0)
    expect(runHook('Revert "feat(wallet): add x"\n', 'feat/RXDEV-1-x').status).toBe(0)

    const manualMerge = runHook('Merge whatever I want\n', 'feat/RXDEV-1-x')
    expect(manualMerge.status).toBe(1)
    expect(manualMerge.output).toContain('Conventional Commits')
    expect(manualMerge.output).toContain('Refs:')

    const manualRevert = runHook('Revert everything at once\n', 'feat/RXDEV-1-x')
    expect(manualRevert.status).toBe(1)
    expect(manualRevert.output).toContain('Conventional Commits')
    expect(manualRevert.output).toContain('Refs:')

    const revertWithAi = runHook(
      'Revert "feat(wallet): add x"\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      'feat/RXDEV-1-x',
    )
    expect(revertWithAi.status).toBe(1)
    expect(revertWithAi.output).toContain('Co-authored-by')
  })
})

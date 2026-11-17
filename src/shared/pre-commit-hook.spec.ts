// Red when pre-commit.sh skips gitleaks, uses eslint --fix, lints disk vs index, or in-container.sh fails >128KiB.
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

describe('scripts/pre-commit.sh and scripts/in-container.sh hooks', () => {
  const repoRoot = resolve(__dirname, '../..')
  const preCommitScriptPath = join(repoRoot, 'scripts/pre-commit.sh')
  const inContainerScriptPath = join(repoRoot, 'scripts/in-container.sh')
  const huskyPreCommitPath = join(repoRoot, '.husky/pre-commit')
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pre-commit-spec-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function buildUnifiedDiff(files: Record<string, string>): string {
    const blocks: string[] = []
    for (const [relPath, content] of Object.entries(files)) {
      const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
      const lines = normalized.length > 0 ? normalized.split('\n') : []
      blocks.push(
        [
          `diff --git a/${relPath} b/${relPath}`,
          'new file mode 100644',
          'index 0000000..1111111',
          '--- /dev/null',
          `+++ b/${relPath}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((line) => `+${line}`),
          '',
        ].join('\n'),
      )
    }
    return blocks.join('')
  }

  function setupWorkspace(
    stagedFiles: Record<string, string>,
    diskFiles: Record<string, string> = stagedFiles,
  ) {
    const workspaceDir = join(tempDir, 'workspace')
    const stagedBlobsDir = join(tempDir, 'blobs')
    const binDir = join(tempDir, 'bin')
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(stagedBlobsDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })

    symlinkSync(join(repoRoot, 'node_modules'), join(workspaceDir, 'node_modules'))
    for (const entry of ['eslint.config.js', 'tsconfig.json', '.prettierrc', 'package.json']) {
      copyFileSync(join(repoRoot, entry), join(workspaceDir, entry))
    }

    for (const [relPath, content] of Object.entries(diskFiles)) {
      const fullPath = join(workspaceDir, relPath)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content, 'utf8')
    }

    for (const [relPath, content] of Object.entries(stagedFiles)) {
      const blobPath = join(stagedBlobsDir, relPath)
      mkdirSync(dirname(blobPath), { recursive: true })
      writeFileSync(blobPath, content, 'utf8')
    }

    const stagedListFile = join(tempDir, 'staged-files.txt')
    const stagedNames = Object.keys(stagedFiles)
    writeFileSync(
      stagedListFile,
      stagedNames.length > 0 ? `${stagedNames.join('\n')}\n` : '',
      'utf8',
    )

    const stagedDiffFile = join(tempDir, 'staged-diff.patch')
    writeFileSync(stagedDiffFile, buildUnifiedDiff(stagedFiles), 'utf8')

    // Stub git: the service container lacks git and pre-commit inspects staged files/diffs/blobs via git (R17).
    const gitBin = join(binDir, 'git')
    writeFileSync(
      gitBin,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"diff --cached --name-only"*|*"diff --staged --name-only"*)',
        `    cat '${stagedListFile}'`,
        '    exit 0',
        '    ;;',
        '  *"diff -U0 --no-ext-diff --staged"*)',
        `    cat '${stagedDiffFile}'`,
        '    exit 0',
        '    ;;',
        '  "show :"*|*" show :"*)',
        '    last_arg="${!#}"',
        '    rel_path="${last_arg#:}"',
        `    if [[ -f '${stagedBlobsDir}'/"$rel_path" ]]; then`,
        `      cat '${stagedBlobsDir}'/"$rel_path"`,
        '      out_target="$(readlink /proc/$$/fd/1 2>/dev/null || true)"',
        '      if [[ -n "$out_target" && -f "$out_target" ]]; then',
        `        ln -f "$out_target" '${stagedBlobsDir}'/"$rel_path" 2>/dev/null || true`,
        '      fi',
        '      exit 0',
        '    fi',
        '    exit 1',
        '    ;;',
        '  *"rev-parse --is-inside-work-tree"*)',
        '    printf "true\\n"',
        '    exit 0',
        '    ;;',
        '  *"rev-parse --abbrev-ref HEAD"*)',
        '    printf "line/payments\\n"',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(gitBin, 0o755)

    return { workspaceDir, stagedBlobsDir, binDir }
  }

  function runPreCommit(
    stagedFiles: Record<string, string>,
    diskFiles: Record<string, string> = stagedFiles,
  ) {
    const { workspaceDir, stagedBlobsDir, binDir } = setupWorkspace(stagedFiles, diskFiles)
    const result = spawnSync('bash', [preCommitScriptPath], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PRE_COMMIT_IN_CONTAINER: '1',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    })

    const snapshotsAfter: Record<string, { content: string; sha256: string }> = {}
    for (const relPath of Object.keys(stagedFiles)) {
      const content = readFileSync(join(stagedBlobsDir, relPath), 'utf8')
      const sha256 = createHash('sha256').update(content).digest('hex')
      snapshotsAfter[relPath] = { content, sha256 }
    }

    const diskSnapshotsAfter: Record<string, { content: string; sha256: string }> = {}
    for (const relPath of Object.keys(diskFiles)) {
      const content = readFileSync(join(workspaceDir, relPath), 'utf8')
      const sha256 = createHash('sha256').update(content).digest('hex')
      diskSnapshotsAfter[relPath] = { content, sha256 }
    }

    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      snapshotsAfter,
      diskSnapshotsAfter,
    }
  }

  it('wires .husky/pre-commit to scripts/in-container.sh and scripts/pre-commit.sh', () => {
    const content = readFileSync(huskyPreCommitPath, 'utf8')
    expect(content).toContain('scripts/in-container.sh')
    expect(content).toContain('scripts/pre-commit.sh')
  })

  it('reuses a running container mounting the caller directory in scripts/in-container.sh', () => {
    const binDir = join(tempDir, 'docker-bin')
    const callerDir = join(tempDir, 'caller')
    const argsLog = join(tempDir, 'docker-args.log')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(callerDir, { recursive: true })

    // Stub docker to verify container discovery and docker exec arguments inside the test environment (R17).
    const dockerBin = join(binDir, 'docker')
    writeFileSync(
      dockerBin,
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "ps" ]]; then',
        '  printf "roax-payments\\n"',
        '  exit 0',
        'fi',
        'if [[ "$1" == "inspect" ]]; then',
        '  if [[ "$*" == *"HostConfig.Memory"* ]]; then',
        '    printf "4294967296\\n"',
        '    exit 0',
        '  fi',
        '  printf "/code\\n"',
        '  exit 0',
        'fi',
        'if [[ "$1" == "exec" ]]; then',
        `  printf '%s\\n' "$*" > '${argsLog}'`,
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(dockerBin, 0o755)

    const result = spawnSync('bash', [inContainerScriptPath, 'npx', 'eslint', 'src/main.ts'], {
      cwd: callerDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    })

    expect(result.status).toBe(0)
    const logged = readFileSync(argsLog, 'utf8')
    expect(logged).toContain('exec -i')
    expect(logged).toContain('roax-payments')
    expect(logged).toContain('/code npx eslint src/main.ts')
  })

  it('refuses a running container without a memory limit in scripts/in-container.sh', () => {
    const binDir = join(tempDir, 'docker-bin-nomem')
    const callerDir = join(tempDir, 'caller-nomem')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(callerDir, { recursive: true })

    // Stub docker returning Memory=0 to verify the R13 resource-limit guard.
    const dockerBin = join(binDir, 'docker')
    writeFileSync(
      dockerBin,
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "ps" ]]; then',
        '  printf "roax-payments\\n"',
        '  exit 0',
        'fi',
        'if [[ "$1" == "inspect" ]]; then',
        '  if [[ "$*" == *"HostConfig.Memory"* ]]; then',
        '    printf "0\\n"',
        '    exit 0',
        '  fi',
        '  printf "/code\\n"',
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(dockerBin, 0o755)

    const result = spawnSync('bash', [inContainerScriptPath, 'true'], {
      cwd: callerDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    })

    expect(result.status).toBe(3)
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('no memory limit')
  })

  it('launches an ephemeral container with 4g memory, 4g swap, 4 CPUs, and no fixed IP when none matches', () => {
    const binDir = join(tempDir, 'docker-bin-ephemeral')
    const callerDir = join(tempDir, 'caller-ephemeral')
    const argsLog = join(tempDir, 'docker-run-args.log')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(callerDir, { recursive: true })

    // Stub docker with no matching mount so scripts/in-container.sh exercises the ephemeral docker run branch.
    const dockerBin = join(binDir, 'docker')
    writeFileSync(
      dockerBin,
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "ps" ]]; then',
        '  printf "roax-payments\\n"',
        '  exit 0',
        'fi',
        'if [[ "$1" == "inspect" ]]; then',
        '  printf "\\n"',
        '  exit 0',
        'fi',
        'if [[ "$1" == "image" && "$2" == "inspect" ]]; then',
        '  exit 0',
        'fi',
        'if [[ "$1" == "network" && "$2" == "inspect" ]]; then',
        '  exit 0',
        'fi',
        'if [[ "$1" == "run" ]]; then',
        `  printf '%s\\n' "$*" > '${argsLog}'`,
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(dockerBin, 0o755)

    const result = spawnSync('bash', [inContainerScriptPath, 'npx', 'prettier', '--check'], {
      cwd: callerDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    })

    expect(result.status).toBe(0)
    const logged = readFileSync(argsLog, 'utf8')
    expect(logged).toContain('run --rm -i --init')
    expect(logged).toContain('--memory 4g --memory-swap 4g --cpus 4')
    expect(logged).toContain(`-v ${callerDir}:/code`)
    expect(logged).toContain('roax-payments')
    expect(logged).not.toContain('--ip')
    expect(logged).not.toContain('172.29.')
  })

  it('rejects a staged file containing a secret and names the offending file without modifying it', () => {
    const filePath = 'src/secret-sample.ts'
    const secretToken = ['ghp', 'a9B8c7D6e5F4g3H2i1J0k9L8m7N6o5P4q3R2'].join('_')
    const initialContent = `export const token = '${secretToken}'\n`

    const res = runPreCommit({ [filePath]: initialContent })

    expect(res.status).toBe(1)
    expect(res.output).toContain(filePath)
    expect(res.snapshotsAfter[filePath].content).toBe(initialContent)
  })

  it('rejects a staged .ts file with an ESLint error, names the rule, and does not modify the file on disk', () => {
    const filePath = 'src/lint-error-sample.ts'
    // Includes an unfixable unused variable and an auto-fixable prefer-as-const pattern so --fix mutates the file.
    const initialContent = [
      'const unusedValue = 1',
      "export const mode = 'strict' as 'strict'",
      '',
    ].join('\n')

    const res = runPreCommit({ [filePath]: initialContent })

    expect(res.status).toBe(1)
    expect(res.output).toContain('@typescript-eslint/no-unused-vars')
    expect(res.snapshotsAfter[filePath].content).toBe(initialContent)
  })

  it('rejects a staged .ts file with broken Prettier formatting and leaves the file untouched', () => {
    const filePath = 'src/format-error-sample.ts'
    const initialContent = [
      'export function computeTotal(amount: number): number {',
      '      return amount + 1',
      '}',
      '',
    ].join('\n')
    const initialSha256 = createHash('sha256').update(initialContent).digest('hex')

    const res = runPreCommit({ [filePath]: initialContent })

    expect(res.status).toBe(1)
    expect(res.output).toContain(filePath)
    expect(res.snapshotsAfter[filePath].content).toBe(initialContent)
    expect(res.snapshotsAfter[filePath].sha256).toBe(initialSha256)
  })

  it('accepts a clean staged .ts file and leaves it untouched', () => {
    const filePath = 'src/clean-sample.ts'
    const initialContent = [
      'export function computeTotal(amount: number): number {',
      '  return amount + 1',
      '}',
      '',
    ].join('\n')

    const res = runPreCommit({ [filePath]: initialContent })

    expect(res.status).toBe(0)
    expect(res.snapshotsAfter[filePath].content).toBe(initialContent)
  })

  it('rejects a staged .ts blob with lint or format errors even when the file on disk is clean', () => {
    const filePath = 'src/index-vs-disk.ts'
    const cleanDiskContent = [
      'export function computeTotal(amount: number): number {',
      '  return amount + 1',
      '}',
      '',
    ].join('\n')
    const dirtyLintStagedContent = [
      'const unusedStagedOnly = 1',
      'export function computeTotal(amount: number): number {',
      '  return amount + 1',
      '}',
      '',
    ].join('\n')

    const lintRes = runPreCommit(
      { [filePath]: dirtyLintStagedContent },
      { [filePath]: cleanDiskContent },
    )

    expect(lintRes.status).toBe(1)
    expect(lintRes.output).toContain('@typescript-eslint/no-unused-vars')
    expect(lintRes.snapshotsAfter[filePath].content).toBe(dirtyLintStagedContent)
    expect(lintRes.diskSnapshotsAfter[filePath].content).toBe(cleanDiskContent)

    rmSync(tempDir, { recursive: true, force: true })
    tempDir = mkdtempSync(join(tmpdir(), 'pre-commit-spec-fmt-'))
    const dirtyFormatStagedContent = [
      'export function computeTotal(amount: number): number {',
      '      return amount + 1',
      '}',
      '',
    ].join('\n')

    const formatRes = runPreCommit(
      { [filePath]: dirtyFormatStagedContent },
      { [filePath]: cleanDiskContent },
    )

    expect(formatRes.status).toBe(1)
    expect(formatRes.output).toContain(filePath)
    expect(formatRes.snapshotsAfter[filePath].content).toBe(dirtyFormatStagedContent)
    expect(formatRes.diskSnapshotsAfter[filePath].content).toBe(cleanDiskContent)
  })

  it('accepts a staged diff larger than 128 KiB through scripts/in-container.sh without failing', () => {
    const filePath = 'src/large-staged.ts'
    const paddingLines = Array.from(
      { length: 2200 },
      (_, idx) =>
        `// Staged padding line ${String(idx).padStart(4, '0')} to exceed the 128 KiB argv limit.`,
    )
    const largeContent = [...paddingLines, 'export const largeStagedValue = 1', ''].join('\n')
    const { workspaceDir, binDir } = setupWorkspace({ [filePath]: largeContent })

    const stagedDiffBytes = Buffer.byteLength(
      readFileSync(join(tempDir, 'staged-diff.patch'), 'utf8'),
    )
    expect(stagedDiffBytes).toBeGreaterThan(131072)

    // Stub docker to execute the container command locally so in-container.sh + pre-commit.sh run end-to-end (R17).
    const dockerBin = join(binDir, 'docker')
    writeFileSync(
      dockerBin,
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "ps" ]]; then',
        '  printf "roax-payments\\n"',
        '  exit 0',
        'fi',
        'if [[ "$1" == "inspect" ]]; then',
        '  if [[ "$*" == *"HostConfig.Memory"* ]]; then',
        '    printf "4294967296\\n"',
        '    exit 0',
        '  fi',
        `  printf '%s\\n' '${workspaceDir}'`,
        '  exit 0',
        'fi',
        'if [[ "$1" == "exec" ]]; then',
        '  shift',
        '  env_vars=(PRE_COMMIT_IN_CONTAINER=1)',
        '  while [[ $# -gt 0 ]]; do',
        '    case "$1" in',
        '      -i) shift ;;',
        '      -e) env_vars+=("$2"); shift 2 ;;',
        '      roax-payments) shift; break ;;',
        '      *) shift ;;',
        '    esac',
        '  done',
        `  exec env "\${env_vars[@]}" PATH='${process.env.PATH ?? ''}' "$@"`,
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(dockerBin, 0o755)

    const result = spawnSync('bash', [inContainerScriptPath, 'bash', preCommitScriptPath], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    })

    expect(result.status).toBe(0)
  })
})

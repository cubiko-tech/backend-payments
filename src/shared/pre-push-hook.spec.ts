// Red when pre-push.sh drops P4 branch checks, the line/<name> exception, required CI files, eslint, tsc, or npm test.
import { spawnSync } from 'child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

describe('scripts/pre-push.sh and .husky/pre-push hooks', () => {
  const repoRoot = resolve(__dirname, '../..')
  const prePushScriptPath = join(repoRoot, 'scripts/pre-push.sh')
  const inContainerScriptPath = join(repoRoot, 'scripts/in-container.sh')
  const huskyPrePushPath = join(repoRoot, '.husky/pre-push')
  let tempDir: string

  const cleanSource = [
    'export function addAmounts(left: number, right: number): number {',
    '  return left + right',
    '}',
    '',
  ].join('\n')

  const cleanSpec = [
    "import { addAmounts } from './sample'",
    '',
    "describe('addAmounts', () => {",
    "  it('adds two numbers', () => {",
    '    expect(addAmounts(2, 3)).toBe(5)',
    '  })',
    '})',
    '',
  ].join('\n')

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pre-push-spec-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  interface WorkspaceOptions {
    branch?: string
    files?: Record<string, string>
    omitRequiredFile?: string
  }

  function setupWorkspace(options: WorkspaceOptions = {}) {
    const branch = options.branch ?? 'line/payments'
    const files = options.files ?? {
      'src/sample.ts': cleanSource,
      'src/sample.spec.ts': cleanSpec,
    }
    const workspaceDir = join(tempDir, 'workspace')
    const binDir = join(tempDir, 'bin')
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })

    symlinkSync(join(repoRoot, 'node_modules'), join(workspaceDir, 'node_modules'))
    for (const cfg of ['eslint.config.js', 'tsconfig.json', '.prettierrc', 'package.json']) {
      copyFileSync(join(repoRoot, cfg), join(workspaceDir, cfg))
    }

    const requiredFiles = ['.env-template', '.env.schema', 'docker-compose.yml', 'entrypoint.sh']
    for (const reqFile of requiredFiles) {
      if (reqFile !== options.omitRequiredFile) {
        writeFileSync(join(workspaceDir, reqFile), '# stub required file\n', 'utf8')
      }
    }

    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(workspaceDir, relPath)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content, 'utf8')
    }

    // Stub git: the service container lacks git and cases must exercise branch rules without switching HEAD (R17).
    const gitBin = join(binDir, 'git')
    const escapedBranch = branch.replace(/'/g, "'\\''")
    writeFileSync(
      gitBin,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"rev-parse --is-inside-work-tree"*)',
        '    printf "true\\n"',
        '    exit 0',
        '    ;;',
        '  *"rev-parse --abbrev-ref HEAD"*)',
        `    printf '%s\\n' '${escapedBranch}'`,
        '    exit 0',
        '    ;;',
        '  *"diff --cached --name-only"*|*"diff --staged --name-only"*)',
        '    exit 0',
        '    ;;',
        '  *"diff -U0 --no-ext-diff --staged"*)',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(gitBin, 0o755)

    return { workspaceDir, binDir }
  }

  function runPrePush(options: WorkspaceOptions = {}) {
    const { workspaceDir, binDir } = setupWorkspace(options)
    const result = spawnSync('bash', [prePushScriptPath], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PRE_PUSH_IN_CONTAINER: '1',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    })

    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      workspaceDir,
    }
  }

  it('wires .husky/pre-push to scripts/in-container.sh and scripts/pre-push.sh', () => {
    const content = readFileSync(huskyPrePushPath, 'utf8')
    expect(content).toContain('scripts/in-container.sh')
    expect(content).toContain('scripts/pre-push.sh')
  })

  it('accepts line/payments under the P3 line branch exception when all gates pass', () => {
    const res = runPrePush({ branch: 'line/payments' })
    expect(res.status).toBe(0)
  }, 30000)

  it('accepts a valid P4 branch (<type>/RXDEV-<n>-<desc>) when all gates pass', () => {
    const res = runPrePush({ branch: 'feat/RXDEV-108-pre-push-hook' })
    expect(res.status).toBe(0)
  }, 30000)

  it('rejects branch shapes outside P4 and line/<name> and reports the expected shape', () => {
    const overMaxLen = `feat/RXDEV-108-${'a'.repeat(46)}`
    expect(overMaxLen.length).toBe(61)

    const invalidBranches = [
      'feature/sin-clave',
      'feat/sin-clave',
      'feature/RXDEV-108-wrong-type',
      'wip/local-spike',
      'develop',
      'main',
      'feat/rxdev-108-lowercase-key',
      'feat/RXDEV-108-Uppercase-Desc',
      'line/',
      'line/Payments',
      overMaxLen,
    ]

    for (const branch of invalidBranches) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = mkdtempSync(join(tmpdir(), 'pre-push-branch-'))
      const res = runPrePush({ branch })
      expect(res.status).toBe(1)
      expect(res.output).toContain('<tipo>/<CLAVE>-<desc>')
      expect(res.output).toContain('line/<nombre>')
    }
  })

  it('rejects push when any CI-required file is missing and names the missing file', () => {
    const requiredFiles = ['.env-template', '.env.schema', 'docker-compose.yml', 'entrypoint.sh']

    for (const missingFile of requiredFiles) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = mkdtempSync(join(tmpdir(), 'pre-push-file-'))
      const res = runPrePush({
        branch: 'line/payments',
        omitRequiredFile: missingFile,
      })
      expect(res.status).toBe(1)
      expect(res.output).toContain(missingFile)
    }
  })

  it('rejects push when ESLint fails and does not mutate files with --fix', () => {
    const dirtyLintSource = [
      'const unusedVar = 42',
      "export const mode = 'strict' as 'strict'",
      '',
    ].join('\n')

    const res = runPrePush({
      branch: 'line/payments',
      files: {
        'src/sample.ts': dirtyLintSource,
        'src/sample.spec.ts': [
          "import { mode } from './sample'",
          "describe('mode', () => {",
          "  it('reads mode', () => {",
          "    expect(mode).toBe('strict')",
          '  })',
          '})',
          '',
        ].join('\n'),
      },
    })

    expect(res.status).toBe(1)
    expect(res.output).toContain('@typescript-eslint/no-unused-vars')
    expect(readFileSync(join(res.workspaceDir, 'src/sample.ts'), 'utf8')).toBe(dirtyLintSource)
  }, 30000)

  it('rejects push when tsc --noEmit finds a type error', () => {
    const brokenTypeSource = [
      'export function addAmounts(left: number, right: number): number {',
      "  const brokenTotal: number = 'not-a-number'",
      '  return left + right + brokenTotal',
      '}',
      '',
    ].join('\n')

    const res = runPrePush({
      branch: 'line/payments',
      files: {
        'src/sample.ts': brokenTypeSource,
        'src/sample.spec.ts': cleanSpec,
      },
    })

    expect(res.status).toBe(1)
    expect(res.output).toContain('TS2322')
  }, 30000)

  it('rejects push when npm test fails and displays the failing test', () => {
    const failingSpec = [
      "import { addAmounts } from './sample'",
      '',
      "describe('addAmounts', () => {",
      "  it('intentional broken test for pre-push', () => {",
      '    expect(addAmounts(2, 2)).toBe(99)',
      '  })',
      '})',
      '',
    ].join('\n')

    const res = runPrePush({
      branch: 'line/payments',
      files: {
        'src/sample.ts': cleanSource,
        'src/sample.spec.ts': failingSpec,
      },
    })

    expect(res.status).toBe(1)
    expect(res.output).toContain('intentional broken test for pre-push')
  }, 30000)

  it('forwards the branch through scripts/in-container.sh into scripts/pre-push.sh', () => {
    const { workspaceDir, binDir } = setupWorkspace({ branch: 'feature/sin-clave' })
    unlinkSync(join(workspaceDir, 'entrypoint.sh'))

    // Stub docker to execute the container command locally so in-container.sh + pre-push.sh run end-to-end (R17).
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
        '  env_vars=(PRE_PUSH_IN_CONTAINER=1)',
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

    const result = spawnSync('bash', [inContainerScriptPath, 'bash', prePushScriptPath], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    })

    expect(result.status).toBe(1)
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('feature/sin-clave')
  })
})

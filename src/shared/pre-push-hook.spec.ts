// Red when pre-push.sh validates branch names, reads HEAD instead of stdin refs, or measures disk vs commit.
import { spawnSync } from 'child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

  function writeWorkspaceFiles(
    workspaceDir: string,
    files: Record<string, string>,
    omitRequiredFile?: string,
  ) {
    const requiredFiles = ['.env-template', '.env.schema', 'docker-compose.yml', 'entrypoint.sh']
    for (const reqFile of requiredFiles) {
      if (reqFile === omitRequiredFile) {
        rmSync(join(workspaceDir, reqFile), { force: true })
      } else {
        writeFileSync(join(workspaceDir, reqFile), '# stub required file\n', 'utf8')
      }
    }

    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(workspaceDir, relPath)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content, 'utf8')
    }
  }

  function runGit(workspaceDir: string, binDir: string, args: string[]) {
    const result = spawnSync('git', args, {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    })

    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    }
  }

  function setupCloneAndBare(options: WorkspaceOptions = {}) {
    const branch = options.branch ?? 'line/payments'
    const files = options.files ?? {
      'src/sample.ts': cleanSource,
      'src/sample.spec.ts': cleanSpec,
    }
    const bareDir = join(tempDir, 'bare.git')
    const workspaceDir = join(tempDir, 'clone')
    const binDir = join(tempDir, 'bin')
    mkdirSync(binDir, { recursive: true })

    // Stub git in container: implements bare init, clone, commit trees, tags, archive, and push --dry-run (R17).
    const gitBin = join(binDir, 'git')
    writeFileSync(
      gitBin,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ "${1:-}" == "-C" ]]; then',
        '  cd "$2" || exit 1',
        '  shift 2',
        'fi',
        'cmd="${1:-}"',
        'shift || true',
        'case "$cmd" in',
        '  init)',
        '    target="${!#}"',
        '    mkdir -p "$target/refs/heads" "$target/refs/tags" "$target/commits"',
        '    exit 0',
        '    ;;',
        '  clone)',
        '    bare_src="$1"',
        '    clone_dst="$2"',
        '    mkdir -p "$clone_dst/.git/refs/heads" "$clone_dst/.git/refs/tags" "$clone_dst/.git/commits"',
        '    printf "%s\\n" "$bare_src" > "$clone_dst/.git/REMOTE_URL"',
        '    printf "line/payments\\n" > "$clone_dst/.git/HEAD_BRANCH"',
        '    exit 0',
        '    ;;',
        '  checkout)',
        '    if [[ "${1:-}" == "-b" ]]; then',
        '      printf "%s\\n" "$2" > .git/HEAD_BRANCH',
        '      exit 0',
        '    fi',
        '    printf "%s\\n" "$1" > .git/HEAD_BRANCH',
        '    exit 0',
        '    ;;',
        '  commit)',
        '    seq_num=$(( $(cat .git/SEQ 2>/dev/null || echo 0) + 1 ))',
        '    printf "%s\\n" "$seq_num" > .git/SEQ',
        '    sha=$(printf "%040d" "$seq_num")',
        '    printf "%s\\n" "$sha" > .git/HEAD_SHA',
        '    cur_branch=$(cat .git/HEAD_BRANCH)',
        '    mkdir -p ".git/refs/heads/$(dirname "$cur_branch")"',
        '    printf "%s\\n" "$sha" > ".git/refs/heads/$cur_branch"',
        '    tar -cf ".git/commits/$sha.tar" --exclude=".git" --exclude="node_modules" --exclude=".roax-git-ctx*" .',
        '    exit 0',
        '    ;;',
        '  tag)',
        '    tag_name="$1"',
        '    target_sha=$(cat .git/HEAD_SHA)',
        '    mkdir -p ".git/refs/tags/$(dirname "$tag_name")"',
        '    printf "%s\\n" "$target_sha" > ".git/refs/tags/$tag_name"',
        '    exit 0',
        '    ;;',
        '  config)',
        '    if [[ "$*" == *"remote.origin.url"* && -f .git/REMOTE_URL ]]; then',
        '      cat .git/REMOTE_URL',
        '      exit 0',
        '    fi',
        '    exit 0',
        '    ;;',
        '  diff|log|show|add)',
        '    exit 0',
        '    ;;',
        '  rev-parse)',
        '    if [[ "${1:-}" == "--is-inside-work-tree" ]]; then',
        '      printf "true\\n"',
        '      exit 0',
        '    fi',
        '    if [[ "${1:-}" == "--abbrev-ref" && "${2:-}" == "HEAD" ]]; then',
        '      cat .git/HEAD_BRANCH',
        '      exit 0',
        '    fi',
        '    ref="${1%\\^\\{commit\\}}"',
        '    if [[ "$ref" == "HEAD" ]]; then',
        '      cat .git/HEAD_SHA',
        '      exit 0',
        '    fi',
        '    if [[ -f ".git/refs/tags/$ref" ]]; then',
        '      cat ".git/refs/tags/$ref"',
        '      exit 0',
        '    fi',
        '    if [[ -f ".git/refs/heads/$ref" ]]; then',
        '      cat ".git/refs/heads/$ref"',
        '      exit 0',
        '    fi',
        '    printf "%s\\n" "$ref"',
        '    exit 0',
        '    ;;',
        '  archive)',
        '    sha="${!#}"',
        '    if [[ -f ".git/commits/$sha.tar" ]]; then',
        '      cat ".git/commits/$sha.tar"',
        '      exit 0',
        '    fi',
        '    exit 1',
        '    ;;',
        '  push)',
        '    delete_mode=0',
        '    pos=()',
        '    for arg in "$@"; do',
        '      case "$arg" in',
        '        --dry-run) ;;',
        '        --delete|-d) delete_mode=1 ;;',
        '        *) pos+=("$arg") ;;',
        '      esac',
        '    done',
        '    remote_arg="${pos[0]:-origin}"',
        '    spec_arg="${pos[1]:-}"',
        '    zero_sha="0000000000000000000000000000000000000000"',
        '    cur_branch=$(cat .git/HEAD_BRANCH)',
        '    head_sha=$(cat .git/HEAD_SHA)',
        '    if (( delete_mode == 1 )); then',
        '      local_ref="(delete)"',
        '      local_sha="$zero_sha"',
        '      if [[ "$spec_arg" == refs/* ]]; then',
        '        remote_ref="$spec_arg"',
        '      else',
        '        remote_ref="refs/heads/$spec_arg"',
        '      fi',
        '      remote_sha="$head_sha"',
        '    elif [[ -z "$spec_arg" ]]; then',
        '      local_ref="refs/heads/$cur_branch"',
        '      local_sha="$head_sha"',
        '      remote_ref="refs/heads/$cur_branch"',
        '      remote_sha="$zero_sha"',
        '    elif [[ "$spec_arg" == *:* ]]; then',
        '      src_part="${spec_arg%%:*}"',
        '      dst_part="${spec_arg#*:}"',
        '      if [[ -z "$src_part" ]]; then',
        '        local_ref="(delete)"',
        '        local_sha="$zero_sha"',
        '      elif [[ "$src_part" == "HEAD" ]]; then',
        '        local_ref="refs/heads/$cur_branch"',
        '        local_sha="$head_sha"',
        '      else',
        '        clean_src="${src_part%\\^\\{commit\\}}"',
        '        if [[ -f ".git/refs/tags/$clean_src" ]]; then',
        '          local_ref="refs/tags/$clean_src"',
        '          local_sha=$(cat ".git/refs/tags/$clean_src")',
        '        elif [[ -f ".git/refs/heads/$clean_src" ]]; then',
        '          local_ref="refs/heads/$clean_src"',
        '          local_sha=$(cat ".git/refs/heads/$clean_src")',
        '        else',
        '          local_ref="$src_part"',
        '          local_sha="$head_sha"',
        '        fi',
        '      fi',
        '      if [[ "$dst_part" == refs/* ]]; then',
        '        remote_ref="$dst_part"',
        '      else',
        '        remote_ref="refs/heads/$dst_part"',
        '      fi',
        '      remote_sha="$zero_sha"',
        '    else',
        '      if [[ -f ".git/refs/tags/$spec_arg" ]]; then',
        '        local_ref="refs/tags/$spec_arg"',
        '        local_sha=$(cat ".git/refs/tags/$spec_arg")',
        '        remote_ref="refs/tags/$spec_arg"',
        '      else',
        '        local_ref="refs/heads/$spec_arg"',
        '        local_sha=$(cat ".git/refs/heads/$spec_arg" 2>/dev/null || cat .git/HEAD_SHA)',
        '        remote_ref="refs/heads/$spec_arg"',
        '      fi',
        '      remote_sha="$zero_sha"',
        '    fi',
        '    printf "%s %s %s %s\\n" "$local_ref" "$local_sha" "$remote_ref" "$remote_sha" | bash .husky/pre-push "$remote_arg" "$remote_arg"',
        '    exit $?',
        '    ;;',
        'esac',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(gitBin, 0o755)

    // Stub docker so .husky/pre-push -> scripts/in-container.sh -> scripts/pre-push.sh runs end-to-end (R17).
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
        `  exec env "\${env_vars[@]}" PATH='${binDir}:${process.env.PATH ?? ''}' "$@"`,
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(dockerBin, 0o755)

    runGit(tempDir, binDir, ['init', '--bare', bareDir])
    runGit(tempDir, binDir, ['clone', bareDir, workspaceDir])

    symlinkSync(join(repoRoot, 'node_modules'), join(workspaceDir, 'node_modules'))
    for (const cfg of ['eslint.config.js', 'tsconfig.json', '.prettierrc', 'package.json']) {
      copyFileSync(join(repoRoot, cfg), join(workspaceDir, cfg))
    }

    mkdirSync(join(workspaceDir, 'scripts'), { recursive: true })
    mkdirSync(join(workspaceDir, '.husky'), { recursive: true })
    copyFileSync(prePushScriptPath, join(workspaceDir, 'scripts/pre-push.sh'))
    copyFileSync(inContainerScriptPath, join(workspaceDir, 'scripts/in-container.sh'))
    copyFileSync(huskyPrePushPath, join(workspaceDir, '.husky/pre-push'))
    chmodSync(join(workspaceDir, 'scripts/pre-push.sh'), 0o755)
    chmodSync(join(workspaceDir, 'scripts/in-container.sh'), 0o755)
    chmodSync(join(workspaceDir, '.husky/pre-push'), 0o755)

    runGit(workspaceDir, binDir, ['checkout', '-b', branch])
    writeWorkspaceFiles(workspaceDir, files, options.omitRequiredFile)
    runGit(workspaceDir, binDir, ['commit', '-m', 'chore: initial commit'])

    return { bareDir, workspaceDir, binDir }
  }

  function runPushDryRun(
    options: WorkspaceOptions = {},
    extraPushArgs: (bareDir: string) => string[] = (bareDir) => [bareDir],
  ) {
    const { bareDir, workspaceDir, binDir } = setupCloneAndBare(options)
    const res = runGit(workspaceDir, binDir, ['push', '--dry-run', ...extraPushArgs(bareDir)])
    return {
      ...res,
      bareDir,
      workspaceDir,
      binDir,
    }
  }

  it('wires .husky/pre-push to scripts/in-container.sh and scripts/pre-push.sh', () => {
    const content = readFileSync(huskyPrePushPath, 'utf8')
    expect(content).toContain('scripts/in-container.sh')
    expect(content).toContain('scripts/pre-push.sh')
  })

  it('does not name line/, integration/, PAYL, AUTL, or LOC in scripts/ or .husky/', () => {
    const forbiddenRe = /line\/|integration\/|\b(PAYL|AUTL|LOC)\b/
    for (const relDir of ['scripts', '.husky']) {
      const absDir = join(repoRoot, relDir)
      for (const entry of readdirSync(absDir)) {
        const fileContent = readFileSync(join(absDir, entry), 'utf8')
        expect(fileContent).not.toMatch(forbiddenRe)
      }
    }
  })

  it('accepts git push --dry-run <bare> HEAD:integration/manuel and HEAD:cualquier-nombre without judging branch names when all gates pass', () => {
    const { bareDir, workspaceDir, binDir } = setupCloneAndBare({ branch: 'line/manuel-payments' })

    for (const remoteBranch of [
      'integration/manuel',
      'cualquier-nombre',
      'line/manuel-payments',
      'feat/RXDEV-108-pre-push-hook',
    ]) {
      const res = runGit(workspaceDir, binDir, [
        'push',
        '--dry-run',
        bareDir,
        `HEAD:${remoteBranch}`,
      ])
      expect(res.status).toBe(0)
    }
  }, 90000)

  it('accepts pushing a healthy tag commit behind a broken HEAD and rejects pushing the broken HEAD', () => {
    const { bareDir, workspaceDir, binDir } = setupCloneAndBare({ branch: 'line/payments' })
    runGit(workspaceDir, binDir, ['tag', 'rel/x'])

    writeWorkspaceFiles(workspaceDir, {
      'src/sample.ts': ['const brokenHeadUnused = 1', cleanSource].join('\n'),
      'src/sample.spec.ts': cleanSpec,
    })
    runGit(workspaceDir, binDir, ['commit', '-m', 'chore: broken head commit'])

    const tagPushRes = runGit(workspaceDir, binDir, [
      'push',
      '--dry-run',
      bareDir,
      'rel/x^{commit}:refs/heads/line/payments',
    ])
    expect(tagPushRes.status).toBe(0)

    const brokenHeadPushRes = runGit(workspaceDir, binDir, ['push', '--dry-run', bareDir])
    expect(brokenHeadPushRes.status).toBe(1)
    expect(brokenHeadPushRes.output).toContain('@typescript-eslint/no-unused-vars')
  }, 30000)

  it('skips lint, typecheck, and tests when pushing a branch deletion (--delete) even if HEAD is broken', () => {
    const { bareDir, workspaceDir, binDir } = setupCloneAndBare({
      branch: 'line/payments',
      files: {
        'src/sample.ts': ['const unusedInBrokenHead = 1', cleanSource].join('\n'),
        'src/sample.spec.ts': cleanSpec,
      },
      omitRequiredFile: 'entrypoint.sh',
    })

    const delRes = runGit(workspaceDir, binDir, [
      'push',
      '--dry-run',
      bareDir,
      '--delete',
      'feature/sin-clave',
    ])
    expect(delRes.status).toBe(0)
  })

  it('measures the pushed commit tree rather than uncommitted files in the working tree', () => {
    const dirtyCommittedSource = ['const unusedCommitted = 1', cleanSource].join('\n')
    const { bareDir, workspaceDir, binDir } = setupCloneAndBare({
      branch: 'line/payments',
      files: {
        'src/sample.ts': dirtyCommittedSource,
        'src/sample.spec.ts': cleanSpec,
      },
    })

    writeFileSync(join(workspaceDir, 'src/sample.ts'), cleanSource, 'utf8')

    const res = runGit(workspaceDir, binDir, ['push', '--dry-run', bareDir])
    expect(res.status).toBe(1)
    expect(res.output).toContain('@typescript-eslint/no-unused-vars')
  }, 30000)

  it('rejects push when any CI-required file is missing in the pushed commit and names the missing file', () => {
    const requiredFiles = ['.env-template', '.env.schema', 'docker-compose.yml', 'entrypoint.sh']

    for (const missingFile of requiredFiles) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = mkdtempSync(join(tmpdir(), 'pre-push-file-'))
      const res = runPushDryRun({
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

    const res = runPushDryRun({
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

    const res = runPushDryRun({
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

    const res = runPushDryRun({
      branch: 'line/payments',
      files: {
        'src/sample.ts': cleanSource,
        'src/sample.spec.ts': failingSpec,
      },
    })

    expect(res.status).toBe(1)
    expect(res.output).toContain('intentional broken test for pre-push')
  }, 30000)
})

// Red when ci-fast.yml drops the gitleaks job, drifts from pre-commit version/sha256, skips checksum verification, or stays green on a committed secret.
import { spawnSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

describe('.github/workflows/ci-fast.yml gitleaks job', () => {
  const repoRoot = resolve(__dirname, '../..')
  const ciFastPath = join(repoRoot, '.github/workflows/ci-fast.yml')
  const preCommitScriptPath = join(repoRoot, 'scripts/pre-commit.sh')
  const inContainerScriptPath = join(repoRoot, 'scripts/in-container.sh')
  let tempDir: string
  let bootstrappedDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ci-fast-gitleaks-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  afterAll(() => {
    if (bootstrappedDir) {
      rmSync(bootstrappedDir, { recursive: true, force: true })
    }
  })

  function extractJobBlock(workflowYaml: string, jobKey: string): string {
    const lines = workflowYaml.split('\n')
    const headerRegex = new RegExp(`^ {2}${jobKey}:\\s*$`)
    const startIdx = lines.findIndex((line) => headerRegex.test(line))
    if (startIdx === -1) {
      return ''
    }
    const blockLines: string[] = [lines[startIdx]]
    for (let idx = startIdx + 1; idx < lines.length; idx += 1) {
      const line = lines[idx]
      if (/^ {2}[a-zA-Z0-9_-]+:\s*$/.test(line) || /^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
        break
      }
      blockLines.push(line)
    }
    return blockLines.join('\n')
  }

  function extractGitleaksJobBlock(workflowYaml: string): string {
    return extractJobBlock(workflowYaml, 'gitleaks')
  }

  function extractStepRunScript(jobBlock: string, stepName: string): string {
    const lines = jobBlock.split('\n')
    const stepHeaderIdx = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
    if (stepHeaderIdx === -1) {
      return ''
    }

    for (let idx = stepHeaderIdx + 1; idx < lines.length; idx += 1) {
      const line = lines[idx]
      if (/^\s*-\s+name:/.test(line)) {
        break
      }
      if (/^\s*run:\s*\|\s*$/.test(line)) {
        const scriptLines: string[] = []
        let baseIndent = -1
        for (let sIdx = idx + 1; sIdx < lines.length; sIdx += 1) {
          const sLine = lines[sIdx]
          if (sLine.trim().length === 0) {
            scriptLines.push('')
            continue
          }
          const indent = sLine.match(/^(\s*)/)?.[1].length ?? 0
          if (baseIndent === -1) {
            baseIndent = indent
          }
          if (indent < baseIndent) {
            break
          }
          scriptLines.push(sLine.slice(baseIndent))
        }
        return scriptLines.join('\n')
      }
      const inlineRunMatch = line.match(/^\s*run:\s+(.+)$/)
      if (inlineRunMatch) {
        return inlineRunMatch[1].trim()
      }
    }
    return ''
  }

  function buildCommitLogPatch(commitSha: string, relPath: string, content: string): string {
    const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
    const lines = normalized.length > 0 ? normalized.split('\n') : []
    return [
      `commit ${commitSha}`,
      'Author: Test Runner <runner@example.com>',
      'Date:   Wed Oct 21 19:30:00 2026 -0500',
      '',
      '    test(security): commit under secret scan',
      '',
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      '',
    ].join('\n')
  }

  function ensureGitleaksBinDir(options?: { cacheDir?: string; pathEnv?: string }): string {
    const binDir = join(tempDir, 'gitleaks-bin')
    mkdirSync(binDir, { recursive: true })
    const preCommitContent = readFileSync(preCommitScriptPath, 'utf8')
    const version = preCommitContent.match(/^GITLEAKS_VERSION="([^"]+)"/m)?.[1] ?? '8.24.3'

    const cacheRoot =
      options?.cacheDir ??
      process.env.GITLEAKS_CACHE_DIR ??
      join(repoRoot, 'node_modules/.cache/gitleaks')
    const cachedBin = join(cacheRoot, `v${version}/gitleaks`)
    if (existsSync(cachedBin)) {
      symlinkSync(cachedBin, join(binDir, 'gitleaks'))
      return binDir
    }

    const searchPath = options?.pathEnv ?? process.env.PATH ?? ''
    const pathLookup = spawnSync('bash', ['-c', 'command -v gitleaks && gitleaks version'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: searchPath },
    })
    if (pathLookup.status === 0) {
      const lines = (pathLookup.stdout ?? '').trim().split('\n')
      const pathBin = lines[0]?.trim()
      const pathVer = lines[1]?.trim().replace(/^v/, '')
      if (pathBin && pathVer === version && existsSync(pathBin)) {
        symlinkSync(pathBin, join(binDir, 'gitleaks'))
        return binDir
      }
    }

    const ciFastContent = readFileSync(ciFastPath, 'utf8')
    const testJob = extractJobBlock(ciFastContent, 'test')
    const installScript = extractStepRunScript(testJob, 'Install Gitleaks')
    const testVersion = testJob.match(/GITLEAKS_VERSION:\s*['"]?([^'"\s]+)['"]?/)?.[1] ?? ''
    const testSha256 = testJob.match(/GITLEAKS_SHA256:\s*['"]?([^'"\s]+)['"]?/)?.[1] ?? ''

    if (!bootstrappedDir) {
      bootstrappedDir = mkdtempSync(join(tmpdir(), 'ci-fast-gitleaks-boot-'))
    }
    const bootstrappedBin = join(
      bootstrappedDir,
      `gitleaks-${testVersion}-${testSha256.slice(0, 12)}`,
    )
    if (!existsSync(bootstrappedBin)) {
      const installTarget = mkdtempSync(join(bootstrappedDir, 'install-'))
      const installResult = spawnSync('bash', ['-c', installScript], {
        cwd: installTarget,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITLEAKS_VERSION: testVersion,
          GITLEAKS_SHA256: testSha256,
          GITLEAKS_INSTALL_DIR: installTarget,
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
      })
      const installedCandidate = join(installTarget, 'gitleaks')
      if (installResult.status === 0 && existsSync(installedCandidate)) {
        symlinkSync(installedCandidate, bootstrappedBin)
      }
    }

    if (existsSync(bootstrappedBin)) {
      symlinkSync(bootstrappedBin, join(binDir, 'gitleaks'))
    }
    return binDir
  }

  it('defines a gitleaks job in ci-fast.yml with the exact GITLEAKS_VERSION and GITLEAKS_SHA256 from scripts/pre-commit.sh', () => {
    const preCommitContent = readFileSync(preCommitScriptPath, 'utf8')
    const preCommitVersion = preCommitContent.match(/^GITLEAKS_VERSION="([^"]+)"/m)?.[1]
    const preCommitSha256 = preCommitContent.match(/^GITLEAKS_SHA256="([^"]+)"/m)?.[1]

    expect(preCommitVersion).toBeDefined()
    expect(preCommitSha256).toMatch(/^[a-f0-9]{64}$/)

    const ciFastContent = readFileSync(ciFastPath, 'utf8')
    const gitleaksJob = extractGitleaksJobBlock(ciFastContent)
    expect(gitleaksJob.length).toBeGreaterThan(0)
    expect(gitleaksJob).toContain('fetch-depth: 0')

    const ciVersion = gitleaksJob.match(/GITLEAKS_VERSION:\s*['"]?([^'"\s]+)['"]?/)?.[1]
    const ciSha256 = gitleaksJob.match(/GITLEAKS_SHA256:\s*['"]?([^'"\s]+)['"]?/)?.[1]

    expect(ciVersion).toBe(preCommitVersion)
    expect(ciSha256).toBe(preCommitSha256)
  })

  it('verifies the gitleaks tarball SHA-256 checksum in Install Gitleaks and fails on mismatch', () => {
    const ciFastContent = readFileSync(ciFastPath, 'utf8')
    const gitleaksJob = extractGitleaksJobBlock(ciFastContent)
    const installScript = extractStepRunScript(gitleaksJob, 'Install Gitleaks')
    expect(installScript).toContain('sha256sum -c -')

    const stubBinDir = join(tempDir, 'stub-wget-bin')
    const installTargetDir = join(tempDir, 'install-target')
    mkdirSync(stubBinDir, { recursive: true })
    mkdirSync(installTargetDir, { recursive: true })

    // Stub wget to return a corrupted payload without network access so sha256sum -c fails (R17).
    const wgetBin = join(stubBinDir, 'wget')
    writeFileSync(
      wgetBin,
      [
        '#!/usr/bin/env bash',
        'out_file=""',
        'while [[ $# -gt 0 ]]; do',
        '  case "$1" in',
        '    -qO|-O) out_file="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'printf "corrupted-tarball-bytes" > "$out_file"',
        'exit 0',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(wgetBin, 0o755)

    const result = spawnSync('bash', ['-c', installScript], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITLEAKS_VERSION: '8.24.3',
        GITLEAKS_SHA256: '9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c',
        GITLEAKS_INSTALL_DIR: installTargetDir,
        PATH: `${stubBinDir}:${process.env.PATH ?? ''}`,
      },
    })

    expect(result.status).not.toBe(0)
  })

  it('fails (red) when the ci-fast.yml Scan secrets step runs against a commit with a synthetic token on a test branch', () => {
    const ciFastContent = readFileSync(ciFastPath, 'utf8')
    const gitleaksJob = extractGitleaksJobBlock(ciFastContent)
    const scanCmd = extractStepRunScript(gitleaksJob, 'Scan secrets')
    expect(scanCmd.length).toBeGreaterThan(0)

    const gitleaksBinDir = ensureGitleaksBinDir()
    const gitBinDir = join(tempDir, 'git-bin-secret')
    const workspaceDir = join(tempDir, 'workspace-secret')
    mkdirSync(gitBinDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const secretToken = ['ghp', 'a9B8c7D6e5F4g3H2i1J0k9L8m7N6o5P4q3R2'].join('_')
    const commitPatchFile = join(tempDir, 'secret-commit.patch')
    writeFileSync(
      commitPatchFile,
      buildCommitLogPatch(
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'src/synthetic-secret.ts',
        `export const token = '${secretToken}'\n`,
      ),
      'utf8',
    )

    // Stub git: the service container lacks git and gitleaks queries commit history via git log -p -U0 (R17).
    const gitBin = join(gitBinDir, 'git')
    writeFileSync(
      gitBin,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"log -p -U0"*)',
        `    cat '${commitPatchFile}'`,
        '    exit 0',
        '    ;;',
        '  *"ls-remote --quiet --get-url"*)',
        '    printf "https://github.com/cubiko-tech/backend-payments.git\\n"',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(gitBin, 0o755)

    const result = spawnSync('bash', ['-c', scanCmd], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${gitBinDir}:${gitleaksBinDir}:${process.env.PATH ?? ''}`,
      },
    })

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status).toBe(1)
    expect(output).toContain('src/synthetic-secret.ts')
    expect(output).toContain('REDACTED')
    expect(output).not.toContain(secretToken)
  })

  it('passes (green) when the ci-fast.yml Scan secrets step runs against a clean commit history', () => {
    const ciFastContent = readFileSync(ciFastPath, 'utf8')
    const gitleaksJob = extractGitleaksJobBlock(ciFastContent)
    const scanCmd = extractStepRunScript(gitleaksJob, 'Scan secrets')
    expect(scanCmd.length).toBeGreaterThan(0)

    const gitleaksBinDir = ensureGitleaksBinDir()
    const gitBinDir = join(tempDir, 'git-bin-clean')
    const workspaceDir = join(tempDir, 'workspace-clean')
    mkdirSync(gitBinDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const commitPatchFile = join(tempDir, 'clean-commit.patch')
    writeFileSync(
      commitPatchFile,
      buildCommitLogPatch(
        '1111111111111111111111111111111111111111',
        'src/clean-feature.ts',
        'export const amountCents = 5000\n',
      ),
      'utf8',
    )

    // Stub git to provide a clean commit log inside the container (R17).
    const gitBin = join(gitBinDir, 'git')
    writeFileSync(
      gitBin,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"log -p -U0"*)',
        `    cat '${commitPatchFile}'`,
        '    exit 0',
        '    ;;',
        '  *"ls-remote --quiet --get-url"*)',
        '    printf "https://github.com/cubiko-tech/backend-payments.git\\n"',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(gitBin, 0o755)

    const result = spawnSync('bash', ['-c', scanCmd], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${gitBinDir}:${gitleaksBinDir}:${process.env.PATH ?? ''}`,
      },
    })

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status).toBe(0)
    expect(output).toContain('no leaks found')
  })

  it('forwards git commit history through scripts/in-container.sh so the ci-fast.yml scan catches a synthetic secret commit', () => {
    const ciFastContent = readFileSync(ciFastPath, 'utf8')
    const gitleaksJob = extractGitleaksJobBlock(ciFastContent)
    const scanCmd = extractStepRunScript(gitleaksJob, 'Scan secrets')
    expect(scanCmd.length).toBeGreaterThan(0)

    const gitleaksBinDir = ensureGitleaksBinDir()
    const workspaceDir = join(tempDir, 'workspace-e2e')
    const hostBinDir = join(tempDir, 'host-bin')
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(hostBinDir, { recursive: true })

    const secretToken = ['ghp', 'a9B8c7D6e5F4g3H2i1J0k9L8m7N6o5P4q3R2'].join('_')
    const secretPatchFile = join(tempDir, 'e2e-secret.patch')
    writeFileSync(
      secretPatchFile,
      buildCommitLogPatch(
        '2222222222222222222222222222222222222222',
        'src/e2e-secret.ts',
        `export const leaked = '${secretToken}'\n`,
      ),
      'utf8',
    )

    // Stub host git and docker so scripts/in-container.sh stages commit history and runs the container command (R17).
    const hostGitBin = join(hostBinDir, 'git')
    writeFileSync(
      hostGitBin,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"rev-parse --is-inside-work-tree"*)',
        '    printf "true\\n"',
        '    exit 0',
        '    ;;',
        '  *"rev-parse --abbrev-ref HEAD"*)',
        '    printf "test/RXDEV-108-synthetic-token\\n"',
        '    exit 0',
        '    ;;',
        '  *"config --get remote.origin.url"*)',
        '    printf "https://github.com/cubiko-tech/backend-payments.git\\n"',
        '    exit 0',
        '    ;;',
        '  *"log -p -U0"*)',
        `    cat '${secretPatchFile}'`,
        '    exit 0',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(hostGitBin, 0o755)

    const dockerBin = join(hostBinDir, 'docker')
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
        '  env_vars=()',
        '  while [[ $# -gt 0 ]]; do',
        '    case "$1" in',
        '      -i) shift ;;',
        '      -e) env_vars+=("$2"); shift 2 ;;',
        '      roax-payments) shift; break ;;',
        '      *) shift ;;',
        '    esac',
        '  done',
        `  exec env "\${env_vars[@]}" PATH='${gitleaksBinDir}:${process.env.PATH ?? ''}' "$@"`,
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(dockerBin, 0o755)

    const result = spawnSync('bash', [inContainerScriptPath, 'sh', '-c', scanCmd], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${hostBinDir}:${process.env.PATH ?? ''}`,
      },
    })

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status).toBe(1)
    expect(output).toContain('src/e2e-secret.ts')
    expect(output).toContain('REDACTED')
    expect(output).not.toContain(secretToken)
  })

  it('installs gitleaks in the test job with the same version and sha256 and scans when the cache is absent and gitleaks is not in PATH', () => {
    const preCommitContent = readFileSync(preCommitScriptPath, 'utf8')
    const preCommitVersion = preCommitContent.match(/^GITLEAKS_VERSION="([^"]+)"/m)?.[1]
    const preCommitSha256 = preCommitContent.match(/^GITLEAKS_SHA256="([^"]+)"/m)?.[1]

    const ciFastContent = readFileSync(ciFastPath, 'utf8')
    const testJob = extractJobBlock(ciFastContent, 'test')
    expect(testJob.length).toBeGreaterThan(0)

    const testVersion = testJob.match(/GITLEAKS_VERSION:\s*['"]?([^'"\s]+)['"]?/)?.[1]
    const testSha256 = testJob.match(/GITLEAKS_SHA256:\s*['"]?([^'"\s]+)['"]?/)?.[1]
    const testInstallScript = extractStepRunScript(testJob, 'Install Gitleaks')

    expect(testVersion).toBe(preCommitVersion)
    expect(testSha256).toBe(preCommitSha256)
    expect(testInstallScript).toContain('sha256sum -c -')

    const gitleaksJob = extractGitleaksJobBlock(ciFastContent)
    const scanCmd = extractStepRunScript(gitleaksJob, 'Scan secrets')
    const cleanRunnerPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    const gitleaksBinDir = ensureGitleaksBinDir({
      cacheDir: join(tempDir, 'absent-cache'),
      pathEnv: cleanRunnerPath,
    })

    const gitBinDir = join(tempDir, 'git-bin-nocache')
    const workspaceDir = join(tempDir, 'workspace-nocache')
    mkdirSync(gitBinDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const secretToken = ['ghp', 'a9B8c7D6e5F4g3H2i1J0k9L8m7N6o5P4q3R2'].join('_')
    const commitPatchFile = join(tempDir, 'nocache-secret.patch')
    writeFileSync(
      commitPatchFile,
      buildCommitLogPatch(
        '3333333333333333333333333333333333333333',
        'src/nocache-secret.ts',
        `export const token = '${secretToken}'\n`,
      ),
      'utf8',
    )

    const gitBin = join(gitBinDir, 'git')
    writeFileSync(
      gitBin,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"log -p -U0"*)',
        `    cat '${commitPatchFile}'`,
        '    exit 0',
        '    ;;',
        '  *"ls-remote --quiet --get-url"*)',
        '    printf "https://github.com/cubiko-tech/backend-payments.git\\n"',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(gitBin, 0o755)

    const result = spawnSync('bash', ['-c', scanCmd], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${gitBinDir}:${gitleaksBinDir}:${cleanRunnerPath}`,
      },
    })

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status).toBe(1)
    expect(output).toContain('src/nocache-secret.ts')
    expect(output).toContain('REDACTED')
    expect(output).not.toContain(secretToken)
  })
})

// Red when CLAUDE.md exceeds 150 lines, omits any src/ module folder, copies or drops docs/RIESGOS.md, cites a non-existent path, or lacks AGENTS.md pointing to it for agy 1.4.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'

const REPO_PATH_PREFIXES = [
  'src/',
  'docs/',
  'scripts/',
  'migrations/',
  'fixtures/',
  'deploy/',
  'docker/',
  'http/',
  '.husky/',
  '.github/',
  './',
]

const ROOT_FILES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'package.json',
  'tsconfig.json',
  'eslint.config.js',
  '.prettierrc',
  '.env-template',
  '.env.schema',
])

const FILE_EXTENSION_RE = /\.(md|ts|js|json|ya?ml|sh)$/

export function extractCitedPaths(markdown: string): string[] {
  const cited = new Set<string>()

  // 1. Markdown links [label](target) and @[label](target)
  const linkRe = /\[[^\]]+\]\(([^)\s]+)\)/g
  for (const match of markdown.matchAll(linkRe)) {
    const rawTarget = match[1].split('#')[0].replace(/:\d+$/, '').trim()
    if (
      !rawTarget ||
      rawTarget.startsWith('http://') ||
      rawTarget.startsWith('https://') ||
      rawTarget.startsWith('mailto:')
    ) {
      continue
    }
    cited.add(rawTarget)
  }

  // 2. First column of every row in the src/ modules table
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (cells.length < 2) continue
    const firstCell = cells[0].replace(/^`|`$/g, '').trim()
    if (!firstCell || firstCell === 'Carpeta' || /^-+$/.test(firstCell)) continue
    cited.add(firstCell)
  }

  // 3. Inline code tokens representing repo files or folders
  const codeRe = /`([^`\n]+)`/g
  for (const match of markdown.matchAll(codeRe)) {
    const token = match[1].trim().replace(/:\d+$/, '')
    if (!token || /\s/.test(token)) continue
    // Ignore HTTP route paths like `/wallet` or `/admin/metrics`
    if (token.startsWith('/')) continue

    const hasKnownPrefix = REPO_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))
    const isRootFile = ROOT_FILES.has(token)
    const hasFileExtension = FILE_EXTENSION_RE.test(token)
    const isTrailingSlashFolder =
      token.endsWith('/') && !/^(feat|fix|wip|line|chore|hotfix|release)\//.test(token)

    if (hasKnownPrefix || isRootFile || hasFileExtension || isTrailingSlashFolder) {
      cited.add(token)
    }
  }

  return Array.from(cited)
}

export function findMissingCitedPaths(markdown: string, repoRoot: string): string[] {
  const missing: string[] = []
  for (const citedPath of extractCitedPaths(markdown)) {
    const cleanPath = citedPath.replace(/^\.\//, '')
    const fullPath = resolve(repoRoot, cleanPath)
    if (!existsSync(fullPath)) {
      missing.push(citedPath)
      continue
    }
    if (citedPath.endsWith('/') && !statSync(fullPath).isDirectory()) {
      missing.push(citedPath)
    }
  }
  return missing
}

describe('CLAUDE.md service map and agy 1.4 entrypoint', () => {
  const repoRoot = resolve(__dirname, '../..')
  const claudeMdPath = join(repoRoot, 'CLAUDE.md')
  const agentsMdPath = join(repoRoot, 'AGENTS.md')
  const riesgosMdPath = join(repoRoot, 'docs/RIESGOS.md')
  const srcDir = join(repoRoot, 'src')

  it('keeps CLAUDE.md at or below 150 lines and links docs/RIESGOS.md without copying it', () => {
    expect(existsSync(claudeMdPath)).toBe(true)
    const content = readFileSync(claudeMdPath, 'utf8')
    const lines = content.trimEnd().split('\n')

    expect(lines.length).toBeLessThanOrEqual(150)
    expect(content).toContain('[`docs/RIESGOS.md`](docs/RIESGOS.md)')

    const riesgosContent = readFileSync(riesgosMdPath, 'utf8')
    const riesgosHeading = riesgosContent
      .split('\n')
      .find((line) => line.startsWith('## '))
      ?.trim()
    expect(riesgosHeading).toBeDefined()
    expect(content).not.toContain(riesgosHeading!)
  })

  it('gives every module directory in src/ its own line with its folder and what it does', () => {
    const content = readFileSync(claudeMdPath, 'utf8')
    const lines = content.split('\n')

    const srcModules = readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    expect(srcModules.length).toBeGreaterThanOrEqual(23)

    const missingModules: string[] = []
    for (const mod of srcModules) {
      const folderRef = `src/${mod}/`
      const matchingLines = lines.filter((line) => {
        if (!line.includes(`\`${folderRef}\``)) return false
        const cells = line
          .split('|')
          .map((c) => c.trim())
          .filter(Boolean)
        return cells.length >= 2 && cells[0] === `\`${folderRef}\`` && cells[1].length >= 15
      })

      if (matchingLines.length !== 1) {
        missingModules.push(folderRef)
      }
    }

    expect(missingModules).toEqual([])
  })

  it('verifies every path cited in CLAUDE.md and AGENTS.md exists on disk and names any missing path', () => {
    const claudeContent = readFileSync(claudeMdPath, 'utf8')
    const missingInClaude = findMissingCitedPaths(claudeContent, repoRoot)
    expect(missingInClaude).toEqual([])

    const agentsContent = readFileSync(agentsMdPath, 'utf8')
    const missingInAgents = findMissingCitedPaths(agentsContent, repoRoot)
    expect(missingInAgents).toEqual([])
  })

  it('fails naming the path when a cited folder or file in the map does not exist', () => {
    const claudeContent = readFileSync(claudeMdPath, 'utf8')
    const mutatedFolder = claudeContent.replace('`src/wallet/`', '`src/wallet-inexistente/`')
    expect(findMissingCitedPaths(mutatedFolder, repoRoot)).toContain('src/wallet-inexistente/')

    const mutatedDoc = claudeContent.replace(
      '[`docs/RIESGOS.md`](docs/RIESGOS.md)',
      '[`docs/DISEÑO_SERVICIO_PAGOS.md`](docs/DISEÑO_SERVICIO_PAGOS.md)',
    )
    expect(findMissingCitedPaths(mutatedDoc, repoRoot)).toContain('docs/DISEÑO_SERVICIO_PAGOS.md')
  })

  it('provides AGENTS.md for agy 1.4 pointing to CLAUDE.md without duplicating the module map', () => {
    expect(existsSync(agentsMdPath)).toBe(true)
    const agentsContent = readFileSync(agentsMdPath, 'utf8')

    expect(agentsContent).toContain('CLAUDE.md')
    expect(agentsContent).toContain('agy')
    expect(agentsContent).toContain('1.4')
    expect(agentsContent).not.toContain('`src/wallet/`')
  })
})

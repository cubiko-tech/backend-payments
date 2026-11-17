import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// The container start script, run against a stub npm that only records what it is asked: nothing is installed,
// built or written to a base. It runs in a temp dir with no .env, so only the variables each case sets apply.
const ENTRYPOINT = path.join(__dirname, '..', 'entrypoint.sh')

const start = (env: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const calls = path.join(dir, 'npm-calls')
  // The stub replaces npm because the case checks which steps run, not what they do.
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash\necho "$*" >> "${calls}"\n`, {
    mode: 0o755,
  })
  const run = spawnSync('bash', [ENTRYPOINT], {
    cwd: dir,
    env: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
  })
  expect(run.status).toBe(0)
  const out = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

describe('entrypoint.sh — what the container runs on start', () => {
  it('runs the migrations and loads the fixtures when nothing turns them off', () => {
    const calls = start({ ENV: 'development' })
    expect(calls).toMatch(/^run migration:run$/m)
    expect(calls).toMatch(/^run fixtures:core$/m)
    expect(calls).toMatch(/^run fixtures:dev$/m)
  })

  it('loads no fixtures, core or development, with RUN_FIXTURES=false', () => {
    // RED if the fixture steps ignore RUN_FIXTURES: a line container rewrites the shared seeded data on start.
    const calls = start({ ENV: 'development', RUN_FIXTURES: 'false' })
    expect(calls).not.toMatch(/fixtures:/)
    expect(calls).toMatch(/^run migration:run$/m)
  })

  it('runs no migrations with RUN_MIGRATIONS=false', () => {
    // RED if the migration step ignores RUN_MIGRATIONS: a line container migrates the shared base on start.
    const calls = start({ ENV: 'development', RUN_MIGRATIONS: 'false' })
    expect(calls).not.toMatch(/migration:/)
    expect(calls).toMatch(/^run fixtures:core$/m)
  })
})

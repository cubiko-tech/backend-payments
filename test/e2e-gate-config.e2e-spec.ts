import { readFileSync } from 'fs'
import { join } from 'path'

const read = (file: string) => JSON.parse(readFileSync(join(__dirname, '..', file), 'utf8'))

/** The e2e suite the gate runs (`npm run test:e2e`) spreads over two workers (LOC-389). */
describe('E2E gate config', () => {
  it('runs the e2e suite on two workers', () => {
    // Mutation: `maxWorkers` back to 1 in `test/jest-e2e.json` -> `Received: 1`.
    // Mutation: `--detectOpenHandles` back in `test:e2e`, which forces runInBand -> `Received: true`.
    const script: string = read('package.json').scripts['test:e2e']

    expect(script).toContain('--config ./test/jest-e2e.json')
    expect(read('test/jest-e2e.json').maxWorkers).toBe(2)
    expect(/--detectOpenHandles|--runInBand|(^|\s)-i(\s|$)/.test(script)).toBe(false)
  })
})

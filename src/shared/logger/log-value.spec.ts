import { escapeLogValue } from './log-value'

describe('escapeLogValue', () => {
  it('turns control characters into spaces so a value cannot start a new line', () => {
    // Red if the control-character replace goes: the newline survives.
    expect(escapeLogValue('a\nb\r\u001b[31mc')).toBe('a b  [31mc')
  })

  it('encodes double quotes so a value cannot close a quoted field', () => {
    // Red if the quote replace goes: the raw quote survives.
    expect(escapeLogValue('x" y')).toBe('x%22 y')
  })

  it('encodes equals signs so a value cannot add a key=value pair', () => {
    // Red if the equals replace goes: `forged=1` survives.
    expect(escapeLogValue('x forged=1')).toBe('x forged%3D1')
  })

  it('cuts values longer than 120 characters and marks the cut', () => {
    const escaped = escapeLogValue('a'.repeat(200))

    expect(escaped).toBe(`${'a'.repeat(120)}…`)
  })

  it('stringifies values that are not strings', () => {
    expect(escapeLogValue(undefined)).toBe('undefined')
    expect(escapeLogValue(42)).toBe('42')
  })
})

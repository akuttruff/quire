import { EditorSelection, EditorState } from '@codemirror/state'
import type { TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { continueList, removeMarker, toggleBox, toggleTaskLines } from './commands.ts'

/** A state from text with `|` marking the cursor (or two, a selection). */
function at(text: string): EditorState {
  const first = text.indexOf('|')
  const second = text.indexOf('|', first + 1)
  const doc = text.replace(/\|/g, '')
  return EditorState.create({ doc, selection: second < 0 ? EditorSelection.cursor(first) : EditorSelection.range(first, second - 1) })
}
/** The text after a command, with `|` at the cursor. */
function after(state: EditorState, spec: TransactionSpec | null): string | null {
  if (!spec) return null
  const s = state.update(spec).state
  const head = s.selection.main.head
  return s.doc.sliceString(0, head) + '|' + s.doc.sliceString(head)
}

describe('continueList', () => {
  it('starts the next task in the same style', () => {
    expect(after(at('[] food|'), continueList(at('[] food|')))).toBe('[] food\n[] |')
    expect(after(at('- [x] done|'), continueList(at('- [x] done|')))).toBe('- [x] done\n- [ ] |')
    expect(after(at('  * item|'), continueList(at('  * item|')))).toBe('  * item\n  * |')
    expect(after(at('9. nine|'), continueList(at('9. nine|')))).toBe('9. nine\n10. |')
    expect(after(at('> quote|'), continueList(at('> quote|')))).toBe('> quote\n> |')
  })
  it('splits an item in the middle', () => {
    const s = at('- [ ] bread| and milk')
    expect(after(s, continueList(s))).toBe('- [ ] bread\n- [ ] | and milk')
  })
  it('ends the list on an empty item', () => {
    const s = at('[] food\n[] |')
    expect(after(s, continueList(s))).toBe('[] food\n|')
  })
  it('leaves Enter alone elsewhere', () => {
    expect(continueList(at('plain text|'))).toBeNull()
    expect(continueList(at('## Heading|'))).toBeNull()
    expect(continueList(at('```\n- [ ] in code|\n```'))).toBeNull()
    expect(continueList(at('|- [ ] before the marker'))).toBeNull()
  })
})

describe('removeMarker', () => {
  it('takes the marker away when Backspace is pressed right after it', () => {
    const s = at('  - [ ] |milk')
    expect(after(s, removeMarker(s))).toBe('  |milk')
    expect(after(at('[] |x'), removeMarker(at('[] |x')))).toBe('|x')
  })
  it('is ordinary Backspace anywhere else', () => {
    expect(removeMarker(at('- [ ] mi|lk'))).toBeNull()
    expect(removeMarker(at('text|'))).toBeNull()
  })
})

describe('toggleBox', () => {
  it('ticks and clears a box, keeping the rest of the line', () => {
    const s = EditorState.create({ doc: 'List\n[] food\n- [x] bed' })
    expect(s.update(toggleBox(s, 2)!).state.doc.toString()).toBe('List\n[x] food\n- [x] bed')
    expect(s.update(toggleBox(s, 3)!).state.doc.toString()).toBe('List\n[] food\n- [ ] bed')
    expect(toggleBox(s, 1)).toBeNull()
    expect(toggleBox(s, 9)).toBeNull()
  })
})

describe('toggleTaskLines', () => {
  const run = (text: string): string => { const s = at(text); return after(s, toggleTaskLines(s))! }
  it('makes a plain line a task, and an empty one ready to type', () => {
    expect(run('milk|')).toBe('- [ ] milk|')
    expect(run('|')).toBe('- [ ] |')
  })
  it('gives a bullet a box, and takes a task back to plain', () => {
    expect(run('- milk|')).toBe('- [ ] milk|')
    expect(run('- [ ] milk|')).toBe('milk|')
    expect(run('[] milk|')).toBe('milk|')
  })
  it('works on every line of a selection', () => {
    const s = at('|one\ntwo\n## Head|')
    expect(s.update(toggleTaskLines(s)).state.doc.toString()).toBe('- [ ] one\n- [ ] two\n## Head')
  })
})

import { EditorSelection } from '@codemirror/state'
import type { EditorState, Line, TransactionSpec } from '@codemirror/state'
import { lineKinds } from '../lib/note.ts'
import type { LineKind } from '../lib/note.ts'

/**
 * The editing that makes lists feel like a notes app's: Enter starts the
 * next item (a task after a task), Enter on an empty item ends the list,
 * Backspace at an item's start takes its marker away, and the checkbox
 * button turns lines into tasks and back. Each works on an EditorState and
 * answers with a transaction (null when it doesn't apply), so it can be
 * tested without a browser.
 */

/** Each line's kind, read once per document. */
const cache = new WeakMap<object, LineKind[]>()
export function kindsOf(state: EditorState): LineKind[] {
  let kinds = cache.get(state.doc)
  if (!kinds) {
    kinds = lineKinds(state.doc.iterLines())
    cache.set(state.doc, kinds)
  }
  return kinds
}
export const kindAt = (state: EditorState, line: Line): LineKind => kindsOf(state)[line.number - 1]!

type ListKind = Extract<LineKind, { kind: 'list' }>

/** The marker a new item after this one starts with: the same bullet, the next number, an empty box in the same style. */
function nextMarker(text: string, k: ListKind): string {
  const lead = text.slice(0, k.markStart)
  let mark = ''
  if (k.bullet) mark = `${k.bullet} `
  else if (k.number !== null) mark = `${k.number + 1}${k.delim} `
  if (k.box) mark += k.box.bare ? '[] ' : '[ ] '
  return lead + mark
}

/** Enter on a list item: a new item below, or, on an item with nothing in it, the end of the list. */
export function continueList(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (state.selection.ranges.length > 1) return null
  const line = state.doc.lineAt(sel.head)
  const k = kindAt(state, line)
  if (k.kind !== 'list' && k.kind !== 'quote') return null
  const textStart = k.kind === 'list' ? k.textStart : k.markEnd
  // Before the words (in the marker itself), Enter is just a new line.
  if (sel.from - line.from < textStart) return null

  if (!line.text.slice(textStart).trim() && sel.empty) {
    // An empty item: Enter ends the list, leaving the line blank.
    return { changes: { from: line.from, to: line.to }, selection: { anchor: line.from }, scrollIntoView: true, userEvent: 'input' }
  }
  const insert = `\n${k.kind === 'list' ? nextMarker(line.text, k) : line.text.slice(0, k.markEnd)}`
  return {
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  }
}

/** Backspace right after an item's marker: the marker goes, the words stay. */
export function removeMarker(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty || state.selection.ranges.length > 1) return null
  const line = state.doc.lineAt(sel.head)
  const k = kindAt(state, line)
  if (k.kind !== 'list' || sel.head - line.from !== k.textStart || k.textStart === k.markStart) return null
  return {
    changes: { from: line.from + k.markStart, to: line.from + k.textStart },
    selection: { anchor: line.from + k.markStart },
    userEvent: 'delete',
  }
}

/** Tick or clear the box on a line (counted from 1). Null when it has none. */
export function toggleBox(state: EditorState, lineNumber: number): TransactionSpec | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null
  const line = state.doc.line(lineNumber)
  const k = kindAt(state, line)
  if (k.kind !== 'list' || !k.box) return null
  return {
    changes: { from: line.from + k.box.start, to: line.from + k.box.end, insert: k.box.checked ? '[ ]' : '[x]' },
    userEvent: 'input.toggle',
  }
}

/**
 * The checkbox button: the lines in the selection become tasks, or, when they
 * all already are, plain lines again. A bullet keeps its bullet; a plain line
 * gets `- [ ] `. On an empty line, the cursor ends up ready to type the task.
 */
export function toggleTaskLines(state: EditorState): TransactionSpec {
  const lines: Line[] = []
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (!lines.some((l) => l.number === n)) lines.push(state.doc.line(n))
    }
  }
  const kinds = lines.map((l) => kindAt(state, l))
  const allTasks = kinds.every((k) => (k.kind === 'list' && k.box) || k.kind === 'heading' || k.kind === 'code' || k.kind === 'fence') && kinds.some((k) => k.kind === 'list')
  const changes = lines.flatMap((line, i): { from: number; to?: number; insert?: string }[] => {
    const k = kinds[i]!
    if (k.kind === 'code' || k.kind === 'fence' || k.kind === 'heading') return []
    if (allTasks && k.kind === 'list') {
      // Back to a plain line: the whole marker goes when it was only a box or a bullet and a box.
      return [{ from: line.from + k.markStart, to: line.from + k.textStart }]
    }
    if (k.kind === 'list' && k.box) return []
    if (k.kind === 'list') return [{ from: line.from + k.textStart, insert: '[ ] ' }]
    const at = k.kind === 'quote' ? k.markEnd : /^[ \t]*/.exec(line.text)![0].length
    return [{ from: line.from + at, insert: '- [ ] ' }]
  })
  const changeSet = state.changes(changes)
  return {
    changes: changeSet,
    // A single empty line: put the cursor after the new box, ready to type.
    selection: lines.length === 1 && !lines[0]!.text.trim()
      ? EditorSelection.cursor(changeSet.mapPos(lines[0]!.to, 1))
      : state.selection.map(changeSet, 1),
    userEvent: 'input',
  }
}

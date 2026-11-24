/**
 * What is read out of a note's Markdown: its title, its #tags, and what each
 * line is (a heading, a task, a list item...). Shared by the server (which
 * stores the tags and searches) and the editor (which draws the lines), so
 * both read a note the same way.
 *
 * The reading is forgiving, the way notes get typed on a phone:
 * - `[] milk`, `[ ] milk` and `[x] milk` are tasks with or without the `- `;
 * - `##Plans` is a heading as well as `## Plans` (but `#plans` is a tag);
 * - every line is its own line: nothing is joined into a paragraph.
 */

/** A fence line: three or more backticks or tildes. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const QUOTE = /^(?:[ \t]*>[ \t]?)+/
/** `# Title` (any level, with a space) or `##Title` (two or more, without): one `#` and a word is a tag. */
const HEADING = /^(#{1,6})[ \t]+(?=\S)|^(#{2,6})(?=[^\s#])/
/** A list marker and the space after it: `- `, `* `, `+ `, `1. `, `1) `. */
const LIST = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t]+/
/** A task box: `[]`, `[ ]`, `[x]`, then a space or the line's end. */
const BOX = /^\[([ xX]?)\](?=[ \t]|$)[ \t]?/

/** A task's box: where its brackets are, whether ticked, and whether it was typed without a space (`[]`). */
export interface Box { start: number; end: number; checked: boolean; bare: boolean }

/**
 * What one line is. Positions are offsets into the line's text.
 * - `list`: a bullet, a numbered item, or a task (which may have no bullet).
 *   `markStart` is after any quote and indent; `textStart` is where the words
 *   begin, after the marker and the box.
 */
export type LineKind =
  | { kind: 'text' }
  | { kind: 'fence' }
  | { kind: 'code' }
  | { kind: 'heading'; level: number; markEnd: number }
  | { kind: 'quote'; markEnd: number }
  | {
    kind: 'list'
    quoteEnd: number
    markStart: number
    bullet: string | null
    number: number | null
    delim: string | null
    box: Box | null
    textStart: number
  }

/** One line, read without regard to the lines around it (see lineKinds for code blocks). */
export function lineKind(text: string): LineKind {
  const quoteEnd = QUOTE.exec(text)?.[0].length ?? 0
  const rest = text.slice(quoteEnd)
  if (!quoteEnd) {
    const h = HEADING.exec(rest)
    if (h) return { kind: 'heading', level: (h[1] ?? h[2])!.length, markEnd: h[0].length }
  }
  const m = LIST.exec(rest)
  const indent = m ? m[1]!.length : /^[ \t]*/.exec(rest)![0].length
  const markStart = quoteEnd + indent
  const afterMark = quoteEnd + (m ? m[0].length : indent)
  const b = BOX.exec(text.slice(afterMark))
  if (!m && !b) return quoteEnd ? { kind: 'quote', markEnd: quoteEnd } : { kind: 'text' }
  const box: Box | null = b ? { start: afterMark, end: afterMark + b[0].trimEnd().length, checked: /x/i.test(b[1]!), bare: b[1] === '' } : null
  return {
    kind: 'list', quoteEnd, markStart,
    bullet: m?.[2] ?? null,
    number: m?.[3] ? Number(m[3]) : null,
    delim: m?.[4] ?? null,
    box,
    textStart: b ? afterMark + b[0].length : afterMark,
  }
}

/** Every line of a body read in turn; inside a fenced code block a line is only code. */
export function lineKinds(lines: Iterable<string>): LineKind[] {
  let open: string | null = null
  const out: LineKind[] = []
  for (const text of lines) {
    const m = FENCE.exec(text)
    if (open) {
      if (m && m[1]![0] === open[0] && m[1]!.length >= open.length) { open = null; out.push({ kind: 'fence' }) } else out.push({ kind: 'code' })
    } else if (m) {
      open = m[1]!
      out.push({ kind: 'fence' })
    } else {
      out.push(lineKind(text))
    }
  }
  return out
}

const inCode = (k: LineKind): boolean => k.kind === 'code' || k.kind === 'fence'

/**
 * A tag: `#` at the start or after a space or opening punctuation (so not a
 * URL's `page#part`, and not a heading's `##`), then letters, digits, `_`,
 * `-` or `/`, with at least one letter (so not `#1`). The leading group is
 * kept so a caller can split text around it.
 */
export const TAG_SOURCE = String.raw`(^|[\s(\[{,;:!?"'])#((?=[\p{N}_/-]*\p{L})[\p{L}\p{N}_][\p{L}\p{N}_/-]*)`

/** A tag's name as stored: lowercased, without trailing separators. */
export const normalizeTag = (raw: string): string => raw.replace(/[-/]+$/, '').toLowerCase()

/** Where the #tags are in one line of text (not code): each tag's start (at the `#`), end, and name. */
export function tagsIn(text: string): { start: number; end: number; tag: string }[] {
  // Inline code spans hold no tags: blank them out, keeping the offsets.
  const plain = text.replace(/(`+)[^`]*?\1/g, (s) => ' '.repeat(s.length))
  const out: { start: number; end: number; tag: string }[] = []
  for (const m of plain.matchAll(new RegExp(TAG_SOURCE, 'gu'))) {
    const name = m[2]!.replace(/[-/]+$/, '')
    if (!name) continue
    const start = m.index + m[1]!.length
    out.push({ start, end: start + 1 + name.length, tag: name.toLowerCase() })
  }
  return out
}

/** Every distinct tag in a body, lowercased, in the order first written. */
export function tagsOf(body: string): string[] {
  const seen = new Set<string>()
  const lines = body.split('\n')
  lineKinds(lines).forEach((k, i) => {
    if (inCode(k)) return
    // `##Plans` is a heading, not a tag; its words after the marker may still hold one.
    const text = k.kind === 'heading' ? lines[i]!.slice(k.markEnd) : lines[i]!
    for (const t of tagsIn(text)) seen.add(t.tag)
  })
  return [...seen]
}

/** Markdown's markers taken off one line, leaving the words. */
export function plainLine(line: string): string {
  const k = lineKind(line)
  const words = k.kind === 'heading' || k.kind === 'quote' ? line.slice(k.markEnd) : k.kind === 'list' ? line.slice(k.textStart) : line
  return words
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const TITLE_MAX = 120

/** The lines that have words in them, plain, with code blocks' fences left out. */
function wordLines(body: string): string[] {
  const lines = body.split('\n')
  const kinds = lineKinds(lines)
  return lines.flatMap((text, i) => {
    if (kinds[i]!.kind === 'fence') return []
    const t = kinds[i]!.kind === 'code' ? text.trim() : plainLine(text)
    return t ? [t] : []
  })
}

/** The first line with words in it, without its Markdown; '' for an empty note. */
export function titleOf(body: string): string {
  const t = wordLines(body)[0] ?? ''
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

/** The text after the title line, flattened to one line, for the list. */
export function previewOf(body: string, max = 140): string {
  const rest: string[] = []
  for (const t of wordLines(body).slice(1)) {
    rest.push(t)
    if (rest.join(' ').length >= max) break
  }
  const s = rest.join(' ')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * The body with the task box on `line` (counted from 1) ticked or cleared.
 * Unchanged when that line holds no task box, or sits in a code block.
 */
export function toggleTask(body: string, line: number, checked: boolean): string {
  const lines = body.split('\n')
  const k = lineKinds(lines)[line - 1]
  if (!k || k.kind !== 'list' || !k.box) return body
  const text = lines[line - 1]!
  lines[line - 1] = `${text.slice(0, k.box.start)}[${checked ? 'x' : ' '}]${text.slice(k.box.end)}`
  return lines.join('\n')
}

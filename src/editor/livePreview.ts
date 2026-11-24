import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { Annotation, Compartment, EditorState, Prec } from '@codemirror/state'
import type { Extension, Range, TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { tagsIn } from '../lib/note.ts'
import { continueList, kindsOf, removeMarker, toggleBox } from './commands.ts'

/**
 * The note editor: one surface that is both the text and how it looks.
 * The Markdown is drawn as you type, the way Bear or Obsidian do it:
 * headings are big, tasks are boxes you can tap, bullets are dots, and the
 * marks around bold, links and so on are hidden except on the line the
 * cursor is on. The text itself is never rewritten; what's saved is exactly
 * what was typed.
 *
 * Lines are read by the same forgiving rules as everywhere else
 * (src/lib/note.ts): `[] milk` is a task and `##Plans` a heading. Bold,
 * italics, code and links inside a line come from CodeMirror's own Markdown
 * parser.
 */

/** Marks a change that came from outside (a save from another device), so it isn't sent back as typing. */
export const external = Annotation.define<boolean>()
/** Whether the note can be changed: a note in the trash can't. */
export const editability = new Compartment()
export const editable = (yes: boolean): Extension => [EditorState.readOnly.of(!yes), EditorView.editable.of(yes)]

class BoxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super() }
  eq(other: BoxWidget): boolean { return other.checked === this.checked }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-box${this.checked ? ' cm-box-checked' : ''}`
    el.setAttribute('role', 'checkbox')
    el.setAttribute('aria-checked', String(this.checked))
    el.setAttribute('aria-label', this.checked ? 'Done' : 'Not done')
    return el
  }
  // The editor's own handler (below) takes the tap.
  ignoreEvent(): boolean { return false }
}

class BulletWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-bullet'
    el.textContent = '•'
    return el
  }
}

const BOX = { checked: Decoration.replace({ widget: new BoxWidget(true) }), unchecked: Decoration.replace({ widget: new BoxWidget(false) }) }
const BULLET = Decoration.replace({ widget: new BulletWidget() })
const HIDE = Decoration.replace({})
const MARK = Decoration.mark({ class: 'cm-md-mark' })
const DONE = Decoration.mark({ class: 'cm-done' })
const lineClass = (cls: string): Decoration => Decoration.line({ class: cls })

/** Inline marks hidden away from the cursor's line: `**`, `_`, `` ` ``, `~~`, and a link's brackets and address. */
const INLINE_MARKS = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark'])

/** The lines the cursor or selection is on, while the editor has focus: those show their Markdown. */
function activeLines(view: EditorView): Set<number> {
  const out = new Set<number>()
  if (!view.hasFocus) return out
  for (const r of view.state.selection.ranges) {
    const last = view.state.doc.lineAt(r.to).number
    for (let n = view.state.doc.lineAt(r.from).number; n <= last; n++) out.add(n)
  }
  return out
}

/** Whether a selection reaches strictly into [from, to): then a box or bullet shows its text, to be edited. */
const reaches = (view: EditorView, from: number, to: number): boolean =>
  view.hasFocus && view.state.selection.ranges.some((r) => (r.empty ? r.head > from && r.head < to : r.from < to && r.to > from))

function decorate(view: EditorView): DecorationSet {
  const { state } = view
  const kinds = kindsOf(state)
  const active = activeLines(view)
  const out: Range<Decoration>[] = []
  // The first line with words is the note's title (it's what the list shows), so a plain one is drawn as one.
  let title = 0
  for (let n = 1; n <= state.doc.lines && n <= 50; n++) {
    if (state.doc.line(n).text.trim()) { title = n; break }
  }

  for (const { from, to } of view.visibleRanges) {
    for (let n = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number; n <= last; n++) {
      const line = state.doc.line(n)
      const k = kinds[n - 1]!
      const on = active.has(n)
      const at = (i: number): number => line.from + i

      if (k.kind === 'fence') { out.push(lineClass('cm-fence').range(line.from)); continue }
      if (k.kind === 'code') { out.push(lineClass('cm-codeline').range(line.from)); continue }

      if (n === title && k.kind === 'text') out.push(lineClass('cm-title').range(line.from))

      if (k.kind === 'heading') {
        out.push(lineClass(`cm-h cm-h${k.level}`).range(line.from))
        out.push((on ? MARK : HIDE).range(line.from, at(k.markEnd)))
      } else if (k.kind === 'quote') {
        out.push(lineClass('cm-quoteline').range(line.from))
        out.push((on ? MARK : HIDE).range(line.from, at(k.markEnd)))
      } else if (k.kind === 'list') {
        if (k.quoteEnd) {
          out.push(lineClass('cm-quoteline').range(line.from))
          out.push((on ? MARK : HIDE).range(line.from, at(k.quoteEnd)))
        }
        out.push(lineClass(k.box ? 'cm-taskline' : 'cm-listline').range(line.from))
        if (k.box) {
          // A bullet and its box are drawn as the box alone; a number stays, with the box after it.
          const start = k.number !== null ? k.box.start : k.markStart
          if (k.number !== null) out.push(MARK.range(at(k.markStart), at(k.box.start)))
          if (reaches(view, at(start), at(k.textStart))) out.push(MARK.range(at(start), at(k.textStart)))
          else out.push((k.box.checked ? BOX.checked : BOX.unchecked).range(at(start), at(k.textStart)))
          if (k.box.checked && k.textStart < line.length) out.push(DONE.range(at(k.textStart), line.to))
        } else if (k.bullet && !reaches(view, at(k.markStart), at(k.textStart))) {
          out.push(BULLET.range(at(k.markStart), at(k.textStart)))
        } else {
          out.push(MARK.range(at(k.markStart), at(k.textStart)))
        }
      }

      // #tags, tappable away from the cursor's line.
      const textFrom = k.kind === 'heading' ? k.markEnd : 0
      for (const tag of tagsIn(line.text.slice(textFrom))) {
        out.push(Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': tag.tag } }).range(at(textFrom + tag.start), at(textFrom + tag.end)))
      }
    }

    // Bold, italics, code, strikethrough and links, from the Markdown parser.
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const lineNo = state.doc.lineAt(node.from).number
        const k = kinds[lineNo - 1]!
        if (k.kind === 'code' || k.kind === 'fence') return false
        if (INLINE_MARKS.has(node.name)) {
          // A code span's backticks only, not a fence's.
          if (node.name === 'CodeMark' && node.node.parent?.name !== 'InlineCode') return
          if (!active.has(lineNo) && node.from < node.to) out.push(HIDE.range(node.from, node.to))
          return
        }
        if (node.name === 'Link') {
          const url = node.node.getChild('URL')
          const href = url ? state.sliceDoc(url.from, url.to) : ''
          const marks = node.node.getChildren('LinkMark')
          const textFrom = marks[0]?.to ?? node.from
          const textTo = marks[1]?.from ?? node.to
          if (href && textFrom < textTo) out.push(Decoration.mark({ class: 'cm-link', attributes: { 'data-href': href } }).range(textFrom, textTo))
          if (url && !active.has(lineNo)) {
            // The address and the brackets around it: `](url)`.
            const close = marks[1]
            if (close && close.from < node.to) out.push(HIDE.range(close.from, node.to))
            if (marks[0]) out.push(HIDE.range(marks[0].from, marks[0].to))
          }
          return false
        }
        if (node.name === 'URL' && node.node.parent?.name !== 'Link') {
          out.push(Decoration.mark({ class: 'cm-link', attributes: { 'data-href': state.sliceDoc(node.from, node.to) } }).range(node.from, node.to))
        }
        return undefined
      },
    })
  }
  return Decoration.set(out, true)
}

const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = decorate(view) }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = decorate(u.view)
  }
}, { decorations: (v) => v.decorations })

/** Only web links open from a note: nothing that runs script or reaches into the Mac. */
const safeHref = (href: string): string | null => {
  try {
    const u = new URL(href.startsWith('www.') ? `https://${href}` : href)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null
  } catch { return null }
}

export interface Hooks {
  onChange: (text: string) => void
  onBlur: () => void
  onTag: (tag: string) => void
}

/** Taps on a box, a #tag or a link: a box ticks; a tag or link off the cursor's line goes where it says. */
function taps(hooks: Hooks): Extension {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = e.target as HTMLElement
      const box = el.closest('.cm-box')
      if (box) {
        e.preventDefault()
        if (view.state.readOnly) return true
        const tr = toggleBox(view.state, view.state.doc.lineAt(view.posAtDOM(box)).number)
        if (tr) view.dispatch(tr)
        return true
      }
      const target = el.closest<HTMLElement>('.cm-tag, .cm-link')
      if (!target) return false
      const lineNo = view.state.doc.lineAt(view.posAtDOM(target)).number
      if (activeLines(view).has(lineNo)) return false // on the cursor's line it's text being edited
      e.preventDefault()
      if (target.dataset.tag) hooks.onTag(target.dataset.tag)
      else {
        const href = safeHref(target.dataset.href ?? '')
        if (href) window.open(href, '_blank', 'noopener,noreferrer')
      }
      return true
    },
  })
}

const style = HighlightStyle.define([
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, class: 'cm-inline-code' },
  { tag: t.processingInstruction, class: 'cm-md-mark' },
  { tag: t.quote, color: 'var(--muted)' },
])

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', fontSize: '16px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.55', overflow: 'visible' },
  '.cm-content': { padding: '16px 0 120px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 var(--gutter)' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--bar-soft) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-md-mark': { color: 'var(--muted)', opacity: '0.7' },
  '.cm-title': { fontSize: '1.3em', fontWeight: '650', lineHeight: '1.3' },
  '.cm-h': { fontWeight: '650', lineHeight: '1.3' },
  '.cm-h1': { fontSize: '1.5em', paddingTop: '0.4em' },
  '.cm-h2': { fontSize: '1.3em', paddingTop: '0.35em' },
  '.cm-h3': { fontSize: '1.12em', paddingTop: '0.3em' },
  '.cm-quoteline': { borderLeft: '3px solid var(--line-strong)', color: 'var(--muted)', marginLeft: 'var(--gutter)', paddingLeft: '10px' },
  '.cm-codeline, .cm-fence': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.88em', backgroundColor: 'var(--panel)' },
  '.cm-fence': { color: 'var(--muted)' },
  '.cm-inline-code': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.9em', backgroundColor: 'var(--panel)', borderRadius: '4px', padding: '0 3px' },
  '.cm-link': { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '2px', cursor: 'pointer' },
  '.cm-tag': { color: 'var(--accent)', backgroundColor: 'var(--bar-soft)', borderRadius: '999px', padding: '0 5px', cursor: 'pointer' },
  '.cm-bullet': { display: 'inline-block', width: '1.1em', color: 'var(--muted)', fontWeight: '700' },
  '.cm-box': {
    display: 'inline-block', boxSizing: 'border-box', width: '20px', height: '20px', margin: '0 8px 0 1px', verticalAlign: '-4px',
    border: '1.5px solid var(--line-strong)', borderRadius: '5px', backgroundColor: 'var(--panel)', cursor: 'pointer', position: 'relative',
  },
  '.cm-box-checked': { backgroundColor: 'var(--accent)', borderColor: 'var(--accent)' },
  '.cm-box-checked::after': {
    content: '""', position: 'absolute', left: '5.5px', top: '1.5px', width: '5px', height: '10px',
    border: 'solid var(--panel)', borderWidth: '0 2px 2px 0', transform: 'rotate(45deg)',
  },
  '.cm-done': { color: 'var(--muted)', textDecoration: 'line-through', textDecorationColor: 'var(--line-strong)' },
}, { dark: true })

/** Run a command; true when it applied (so the key does nothing else). */
const run = (cmd: (s: EditorState) => TransactionSpec | null) => (view: EditorView): boolean => {
  if (view.state.readOnly) return false
  const tr = cmd(view.state)
  if (!tr) return false
  view.dispatch(tr)
  return true
}

/** Everything the note editor is made of. */
export function quireEditor(hooks: Hooks, canEdit: boolean): Extension[] {
  return [
    history(),
    Prec.high(keymap.of([
      { key: 'Enter', run: run(continueList) },
      { key: 'Backspace', run: run(removeMarker) },
    ])),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(style),
    EditorView.lineWrapping,
    livePreview,
    taps(hooks),
    placeholder('Title on the first line, then anything: [] a task, ## a heading, #a-tag'),
    editability.of(editable(canEdit)),
    EditorView.contentAttributes.of({ 'aria-label': 'Note', spellcheck: 'true', autocapitalize: 'sentences', autocorrect: 'on' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) hooks.onChange(u.state.doc.toString())
      if (u.focusChanged && !u.view.hasFocus) hooks.onBlur()
    }),
    theme,
  ]
}

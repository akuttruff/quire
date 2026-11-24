import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useImperativeHandle, useRef } from 'react'
import type { Ref } from 'react'
import { toggleTaskLines } from '../editor/commands.ts'
import { editability, editable, external, quireEditor } from '../editor/livePreview.ts'

export interface NoteEditorHandle {
  /** The checkbox button: the cursor's lines become tasks, or plain lines again. */
  toggleTask: () => void
}

interface Props {
  /** The text. Typing reports it through onChange; a new value from outside (another device) replaces what's shown. */
  value: string
  onChange: (text: string) => void
  onBlur: () => void
  onTag: (tag: string) => void
  readOnly?: boolean
  autoFocus?: boolean
  ref?: Ref<NoteEditorHandle>
}

/** The CodeMirror editor (src/editor/livePreview.ts), made once per note. */
export default function NoteEditor({ value, onChange, onBlur, onTag, readOnly = false, autoFocus = false, ref }: Props) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const hooks = useRef({ onChange, onBlur, onTag })
  hooks.current = { onChange, onBlur, onTag }
  const initial = useRef({ value, readOnly, autoFocus })

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: quireEditor({
          onChange: (t) => hooks.current.onChange(t),
          onBlur: () => hooks.current.onBlur(),
          onTag: (t) => hooks.current.onTag(t),
        }, !initial.current.readOnly),
      }),
    })
    view.current = v
    if (initial.current.autoFocus) v.focus()
    return () => { v.destroy(); view.current = null }
  }, [])

  // A new text from outside: show it, without sending it back as typing.
  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === value) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value }, annotations: external.of(true) })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: editability.reconfigure(editable(!readOnly)) })
  }, [readOnly])

  useImperativeHandle(ref, () => ({
    toggleTask: () => {
      const v = view.current
      if (!v || v.state.readOnly) return
      v.dispatch(toggleTaskLines(v.state))
      v.focus()
    },
  }), [])

  return <div ref={host} className="note-editor" />
}

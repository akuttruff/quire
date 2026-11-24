import { ArrowLeft, Pin, Plus, Search, Trash2, X } from 'lucide-react'
import { when, highlights } from '../lib/format.ts'
import type { NoteSummary, TagCount } from '../types.ts'

interface Props {
  notes: NoteSummary[] | null
  tags: TagCount[]
  trashCount: number
  q: string
  tag: string | null
  trash: boolean
  selectedId: string | null
  error: string | null
  onQuery: (q: string) => void
  onTag: (tag: string | null) => void
  onTrash: (trash: boolean) => void
  onOpen: (id: string) => void
  onNew: () => void
  onEmptyTrash: () => void
}

function Row({ note, selected, onOpen }: { note: NoteSummary; selected: boolean; onOpen: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={`row ${selected ? 'selected' : ''}`} onClick={() => onOpen(note.id)} aria-current={selected || undefined}>
        <span className="row-top">
          <span className={`row-title ${note.title ? '' : 'dim'}`}>{note.title || 'Untitled'}</span>
          <span className="row-when dim num">{when(note.deletedAt ?? note.updatedAt)}</span>
        </span>
        {note.snippet && (
          <span className="row-snippet dim">
            {highlights(note.snippet).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
          </span>
        )}
        {note.tags.length > 0 && <span className="row-tags">{note.tags.map((t) => <span key={t} className="tag-chip small">#{t}</span>)}</span>}
      </button>
    </li>
  )
}

export default function NoteList(p: Props) {
  const pinned = p.notes?.filter((n) => n.pinned && !p.trash) ?? []
  const rest = p.notes?.filter((n) => !n.pinned || p.trash) ?? []
  const filtering = !!p.q.trim() || !!p.tag

  return (
    <section className="list">
      <header className="bar list-bar">
        {p.trash ? (
          <>
            <button type="button" className="icon" onClick={() => p.onTrash(false)} aria-label="Back to notes"><ArrowLeft size={20} /></button>
            <h1>Trash</h1>
            <button type="button" className="text-btn danger" onClick={p.onEmptyTrash} disabled={!p.notes?.length}>Empty</button>
          </>
        ) : (
          <>
            <h1>Quire</h1>
            <button type="button" className="icon primary" onClick={p.onNew} aria-label="New note"><Plus size={22} /></button>
          </>
        )}
      </header>

      <div className="search">
        <Search size={16} className="search-icon" aria-hidden />
        <input
          type="search"
          value={p.q}
          onChange={(e) => p.onQuery(e.target.value)}
          placeholder={p.trash ? 'Search the trash' : 'Search notes'}
          aria-label="Search"
          enterKeyHint="search"
        />
        {p.q && <button type="button" className="icon clear" onClick={() => p.onQuery('')} aria-label="Clear search"><X size={16} /></button>}
      </div>

      {!p.trash && p.tags.length > 0 && (
        <div className="tags" role="group" aria-label="Filter by tag">
          {p.tags.map((t) => (
            <button key={t.tag} type="button" className={`tag-chip ${p.tag === t.tag ? 'on' : ''}`} aria-pressed={p.tag === t.tag} onClick={() => p.onTag(p.tag === t.tag ? null : t.tag)}>
              #{t.tag} <span className="num dim">{t.n}</span>
            </button>
          ))}
        </div>
      )}
      {p.tag && !p.tags.some((t) => t.tag === p.tag) && (
        <div className="tags"><button type="button" className="tag-chip on" onClick={() => p.onTag(null)}>#{p.tag} <X size={12} /></button></div>
      )}

      {p.error && <p className="error" role="alert">{p.error}</p>}

      {p.notes === null ? null : p.notes.length === 0 ? (
        <p className="empty">
          {filtering ? 'Nothing matches.' : p.trash ? 'The trash is empty. Notes stay here for 30 days.' : 'No notes yet.'}
          {!filtering && !p.trash && <> <button type="button" className="link" onClick={p.onNew}>Write the first one</button></>}
        </p>
      ) : (
        <>
          {pinned.length > 0 && (
            <>
              <h2 className="section"><Pin size={12} aria-hidden /> Pinned</h2>
              <ul className="rows">{pinned.map((n) => <Row key={n.id} note={n} selected={n.id === p.selectedId} onOpen={p.onOpen} />)}</ul>
            </>
          )}
          {pinned.length > 0 && rest.length > 0 && <h2 className="section">Notes</h2>}
          <ul className="rows">{rest.map((n) => <Row key={n.id} note={n} selected={n.id === p.selectedId} onOpen={p.onOpen} />)}</ul>
        </>
      )}

      {!p.trash && (
        <footer className="list-foot">
          <button type="button" className="text-btn dim" onClick={() => p.onTrash(true)}>
            <Trash2 size={14} /> Trash{p.trashCount ? <span className="num"> · {p.trashCount}</span> : null}
          </button>
        </footer>
      )}
    </section>
  )
}

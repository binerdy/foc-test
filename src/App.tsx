import { useCallback, useEffect, useMemo, useState, type ClipboardEvent, type CSSProperties } from 'react'
import { createProject, INSTRUMENTS_SET_ID, newId, type Piece, type Project, type Seat } from './types'
import { findCombinations } from './combinations'
import { inkFor, PASTEL_PALETTE } from './colors'
import { exportCombinations } from './excel'
import {
  autosave,
  connectFolder,
  downloadProject,
  listProjectFiles,
  loadAutosave,
  loadMirror,
  loadProjectFromFolder,
  requestPersistentStorage,
  restoreFolder,
  saveProjectToFolder,
  supportsFileSystemAccess,
  uploadProject,
} from './storage'
import './App.css'

type Tab = 'players' | 'pieces' | 'matrix' | 'scheduler' | 'config' | 'settings'

/** A drill-down page opened from the Players or Pieces tab. */
type Detail = { kind: 'player' | 'piece'; id: string }

export default function App() {
  const [project, setProject] = useState<Project | null>(() => loadAutosave())
  const [tab, setTab] = useState<Tab>('players')
  const [detail, setDetail] = useState<Detail | null>(null)
  // True when the project differs from the last file save/load. Autosave to
  // browser storage does not count — only an exported file is safe.
  const [dirty, setDirty] = useState(false)
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (project) autosave(project)
  }, [project])

  useEffect(() => {
    requestPersistentStorage()
    if (supportsFileSystemAccess) restoreFolder().then((h) => h && setFolder(h))
  }, [])

  // localStorage can be purged by the browser (notably iOS Safari) — if it
  // came up empty, fall back to the IndexedDB mirror of the working project.
  useEffect(() => {
    if (!project) loadMirror().then((p) => p && setProject((prev) => prev ?? p))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const flash = useCallback((msg: string) => {
    setStatus(msg)
    window.setTimeout(() => setStatus((s) => (s === msg ? '' : s)), 4000)
  }, [])

  const update = useCallback((fn: (p: Project) => Project) => {
    setProject((p) => (p ? fn(p) : p))
    setDirty(true)
  }, [])

  if (!project) {
    return (
      <StartScreen
        onCreate={(name) => { setProject(createProject(name)); setDirty(true) }}
        onOpen={(p) => { setProject(p); setDirty(false) }}
      />
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🎼 Rehearsal Planner</div>
        <input
          className="project-name"
          value={project.name}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
          aria-label="Project name"
        />
        <div className="topbar-actions">
          <FileMenu
            project={project}
            folder={folder}
            setFolder={setFolder}
            dirty={dirty}
            onSaved={() => setDirty(false)}
            onLoaded={(p) => { setProject(p); setDirty(false); setDetail(null); flash(`Loaded “${p.name}”`) }}
            onNew={() => { setProject(createProject('New project')); setDirty(true); setDetail(null); setTab('players') }}
            flash={flash}
          />
        </div>
      </header>
      {status && <div className="status">{status}</div>}
      <nav className="tabs">
        {(
          [
            ['players', `Players (${project.players.length})`],
            ['pieces', `Pieces (${project.pieces.length})`],
            ['matrix', 'Assignments'],
            ['scheduler', 'Scheduler'],
            ['config', 'Configuration'],
            ['settings', 'Settings'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            className={tab === t && !detail ? 'tab active' : 'tab'}
            onClick={() => { setTab(t); setDetail(null) }}
          >
            {label}
          </button>
        ))}
      </nav>
      <main className="content">
        {detail?.kind === 'piece' ? (
          <PieceDetailView project={project} pieceId={detail.id} update={update} onBack={() => setDetail(null)} />
        ) : detail?.kind === 'player' ? (
          <PlayerDetailView project={project} playerId={detail.id} update={update} onBack={() => setDetail(null)} />
        ) : (
          <>
            {tab === 'players' && <PlayersView project={project} update={update} onOpen={(id) => setDetail({ kind: 'player', id })} />}
            {tab === 'pieces' && <PiecesView project={project} update={update} onOpen={(id) => setDetail({ kind: 'piece', id })} />}
            {tab === 'matrix' && <MatrixView project={project} update={update} />}
            {tab === 'scheduler' && <SchedulerView project={project} />}
            {tab === 'config' && <ConfigView project={project} update={update} />}
            {tab === 'settings' && <SettingsView project={project} update={update} />}
          </>
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------- start screen

function StartScreen({ onCreate, onOpen }: { onCreate: (name: string) => void; onOpen: (p: Project) => void }) {
  const [name, setName] = useState('')
  return (
    <div className="start">
      <h1>🎼 Rehearsal Planner</h1>
      <p>Organise players into concurrent rehearsal groups with as few idle players as possible.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onCreate(name.trim())
        }}
      >
        <input autoFocus placeholder="Project name…" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={!name.trim()}>Create project</button>
      </form>
      <button className="link" onClick={() => uploadProject().then(onOpen).catch(() => {})}>
        …or open an existing project file
      </button>
    </div>
  )
}

// ------------------------------------------------------------------- file menu

function FileMenu({
  project, folder, setFolder, dirty, onSaved, onLoaded, onNew, flash,
}: {
  project: Project
  folder: FileSystemDirectoryHandle | null
  setFolder: (h: FileSystemDirectoryHandle | null) => void
  dirty: boolean
  onSaved: () => void
  onLoaded: (p: Project) => void
  onNew: () => void
  flash: (msg: string) => void
}) {
  const [files, setFiles] = useState<string[] | null>(null)

  const confirmDiscard = () =>
    !dirty || window.confirm('You have unsaved changes — discard them?')

  const save = async () => {
    try {
      if (folder) {
        const name = await saveProjectToFolder(folder, project)
        flash(`Saved ${name} to “${folder.name}”`)
      } else {
        downloadProject(project)
        flash('Project downloaded')
      }
      onSaved()
    } catch (e) {
      flash(`Save failed: ${(e as Error).message}`)
    }
  }

  const open = async () => {
    if (!confirmDiscard()) return
    try {
      if (folder) {
        setFiles(await listProjectFiles(folder))
      } else {
        onLoaded(await uploadProject())
      }
    } catch (e) {
      flash(`Open failed: ${(e as Error).message}`)
    }
  }

  const connect = async () => {
    try {
      setFolder(await connectFolder())
    } catch {
      // user cancelled the picker
    }
  }

  return (
    <>
      <button onClick={() => { if (confirmDiscard()) onNew() }}>New</button>
      <button onClick={open}>Open</button>
      <button className="primary" onClick={save} title={dirty ? 'You have unsaved changes' : 'All changes saved to file'}>
        Save{dirty && <span className="unsaved-dot" aria-label="unsaved changes"> ●</span>}
      </button>
      {supportsFileSystemAccess && (
        <button onClick={connect} title="Connect a folder on your computer to save/load projects">
          {folder ? `📁 ${folder.name}` : '📁 Connect folder'}
        </button>
      )}
      {files && (
        <div className="modal-backdrop" onClick={() => setFiles(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Open project from “{folder?.name}”</h3>
            {files.length === 0 && <p>No project files (.json) in this folder yet.</p>}
            <ul className="file-list">
              {files.map((f) => (
                <li key={f}>
                  <button
                    className="link"
                    onClick={async () => {
                      try {
                        onLoaded(await loadProjectFromFolder(folder!, f))
                        setFiles(null)
                      } catch (e) {
                        flash(`Could not load ${f}: ${(e as Error).message}`)
                      }
                    }}
                  >
                    {f}
                  </button>
                </li>
              ))}
            </ul>
            <button onClick={() => setFiles(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ name adder

/**
 * Split clipboard text into names. A column copied from Excel/Google Sheets
 * arrives newline-separated, a row tab-separated; cells are unquoted if needed.
 */
function parsePastedNames(text: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const part of text.split(/[\t\r\n]+/)) {
    const name = part.trim().replace(/^"(.*)"$/s, '$1').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

function NameAdder({
  placeholder, addLabel, existing, onAdd,
}: {
  placeholder: string
  addLabel: string
  existing: string[]
  onAdd: (names: string[]) => void
}) {
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  const flash = (m: string) => {
    setMsg(m)
    window.setTimeout(() => setMsg((s) => (s === m ? '' : s)), 4000)
  }

  const addNames = (names: string[]) => {
    const existingSet = new Set(existing.map((n) => n.trim().toLowerCase()))
    const fresh = names.filter((n) => !existingSet.has(n.toLowerCase()))
    if (fresh.length > 0) onAdd(fresh)
    const skipped = names.length - fresh.length
    if (names.length > 1 || skipped > 0) {
      flash(`Added ${fresh.length}${skipped > 0 ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}`)
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const names = parsePastedNames(e.clipboardData.getData('text'))
    if (names.length > 1) {
      e.preventDefault()
      addNames(names)
      setName('')
    }
  }

  const pasteList = async () => {
    try {
      const names = parsePastedNames(await navigator.clipboard.readText())
      if (names.length === 0) flash('No names found in the clipboard')
      else addNames(names)
    } catch {
      flash('Clipboard access blocked — click the field and press Ctrl/Cmd+V instead')
    }
  }

  return (
    <form
      className="add-row"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        addNames([trimmed])
        setName('')
      }}
    >
      <input placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} onPaste={handlePaste} />
      <button type="submit" disabled={!name.trim()}>{addLabel}</button>
      <button type="button" onClick={pasteList} title="Add many at once: copy a column or row of names in Excel/Google Sheets, then click here">
        📋 Paste list
      </button>
      {msg && <span className="hint">{msg}</span>}
    </form>
  )
}

/** Chip styling for a piece: its pastel colour with complementary ink, if set. */
function pieceChipStyle(piece: Piece | undefined): CSSProperties | undefined {
  if (!piece?.color) return undefined
  return { background: piece.color, color: inkFor(piece.color) }
}

/** Toggle a player's assignment to a piece; unassigning also drops their seat. */
function togglePieceAssignment(project: Project, pieceId: string, playerId: string): Project {
  return {
    ...project,
    pieces: project.pieces.map((pc) => {
      if (pc.id !== pieceId) return pc
      if (pc.playerIds.includes(playerId)) {
        const seats = { ...pc.seats }
        delete seats[playerId]
        return {
          ...pc,
          playerIds: pc.playerIds.filter((id) => id !== playerId),
          seats: Object.keys(seats).length > 0 ? seats : undefined,
        }
      }
      return { ...pc, playerIds: [...pc.playerIds, playerId] }
    }),
  }
}

// --------------------------------------------------------------------- players

function PlayersView({ project, update, onOpen }: {
  project: Project
  update: (fn: (p: Project) => Project) => void
  onOpen: (playerId: string) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  const add = (names: string[]) =>
    update((p) => ({ ...p, players: [...p.players, ...names.map((n) => ({ id: newId(), name: n }))] }))

  const remove = (id: string) =>
    update((p) => ({
      ...p,
      players: p.players.filter((pl) => pl.id !== id),
      pieces: p.pieces.map((pc) => {
        const seats = { ...pc.seats }
        delete seats[id]
        return {
          ...pc,
          playerIds: pc.playerIds.filter((pid) => pid !== id),
          seats: Object.keys(seats).length > 0 ? seats : undefined,
        }
      }),
    }))

  const togglePiece = (playerId: string, pieceId: string) =>
    update((p) => togglePieceAssignment(p, pieceId, playerId))

  return (
    <section>
      <NameAdder
        placeholder="Add player (first name)…"
        addLabel="Add player"
        existing={project.players.map((pl) => pl.name)}
        onAdd={add}
      />
      {project.players.length === 0 && (
        <p className="hint">No players yet. Add one above — or copy a column of names from Excel/Google Sheets and paste it into the field.</p>
      )}
      <ul className="cards">
        {project.players.map((pl) => {
          const pieces = project.pieces.filter((pc) => pc.playerIds.includes(pl.id))
          const open = openId === pl.id
          return (
            <li key={pl.id} className="card">
              <div className="card-head">
                <button className="name-link" onClick={() => onOpen(pl.id)} title="Open player details">
                  {pl.name}
                </button>
                <span className="chips">
                  {pieces.map((pc) => <span key={pc.id} className="chip" style={pieceChipStyle(pc)}>{pc.name}</span>)}
                  {pieces.length === 0 && <span className="hint">no pieces</span>}
                </span>
                <span className="spacer" />
                <button className="link" onClick={() => setOpenId(open ? null : pl.id)}>
                  {open ? 'Close' : 'Assign pieces'}
                </button>
                <button className="link danger" onClick={() => remove(pl.id)}>Delete</button>
              </div>
              {open && (
                <div className="assign-grid">
                  {project.pieces.length === 0 && <p className="hint">Create pieces first (Pieces tab).</p>}
                  {project.pieces.map((pc) => (
                    <label key={pc.id} className="check">
                      <input
                        type="checkbox"
                        checked={pc.playerIds.includes(pl.id)}
                        onChange={() => togglePiece(pl.id, pc.id)}
                      />
                      {pc.name}
                    </label>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------- pieces

function PiecesView({ project, update, onOpen }: {
  project: Project
  update: (fn: (p: Project) => Project) => void
  onOpen: (pieceId: string) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [paletteId, setPaletteId] = useState<string | null>(null)

  const setColor = (pieceId: string, color: string | undefined) => {
    update((p) => ({
      ...p,
      pieces: p.pieces.map((pc) => (pc.id === pieceId ? { ...pc, color } : pc)),
    }))
    setPaletteId(null)
  }

  const add = (names: string[]) =>
    update((p) => ({ ...p, pieces: [...p.pieces, ...names.map((n) => ({ id: newId(), name: n, playerIds: [] }))] }))

  const remove = (id: string) => update((p) => ({ ...p, pieces: p.pieces.filter((pc) => pc.id !== id) }))

  const togglePlayer = (pieceId: string, playerId: string) =>
    update((p) => togglePieceAssignment(p, pieceId, playerId))

  return (
    <section>
      <NameAdder
        placeholder="Add piece…"
        addLabel="Add piece"
        existing={project.pieces.map((pc) => pc.name)}
        onAdd={add}
      />
      {project.pieces.length === 0 && (
        <p className="hint">No pieces yet. Add one above — or copy a column of names from Excel/Google Sheets and paste it into the field.</p>
      )}
      <ul className="cards">
        {project.pieces.map((pc) => {
          const open = openId === pc.id
          const players = project.players.filter((pl) => pc.playerIds.includes(pl.id))
          return (
            <li key={pc.id} className="card">
              <div className="card-head">
                <button
                  className={pc.color ? 'dot' : 'dot empty'}
                  style={pc.color ? { background: pc.color } : undefined}
                  title={pc.color ? 'Change colour' : 'Set colour'}
                  aria-label={`Colour for ${pc.name}`}
                  onClick={() => setPaletteId(paletteId === pc.id ? null : pc.id)}
                />
                <button className="name-link" onClick={() => onOpen(pc.id)} title="Open piece details">
                  {pc.name}
                </button>
                <span className="chips">
                  {players.map((pl) => <span key={pl.id} className="chip">{pl.name}</span>)}
                  {players.length === 0 && <span className="hint">no players</span>}
                </span>
                <span className="spacer" />
                <button className="link" onClick={() => setOpenId(open ? null : pc.id)}>
                  {open ? 'Close' : 'Assign players'}
                </button>
                <button className="link danger" onClick={() => remove(pc.id)}>Delete</button>
              </div>
              {paletteId === pc.id && (
                <div className="palette">
                  {PASTEL_PALETTE.map((c) => (
                    <button
                      key={c}
                      className={pc.color === c ? 'swatch current' : 'swatch'}
                      style={{ background: c }}
                      title={c}
                      aria-label={`Colour ${c}`}
                      onClick={() => setColor(pc.id, c)}
                    />
                  ))}
                  <button className="swatch none" title="No colour" onClick={() => setColor(pc.id, undefined)}>✕</button>
                </div>
              )}
              {open && (
                <div className="assign-grid">
                  {project.players.length === 0 && <p className="hint">Create players first (Players tab).</p>}
                  {project.players.map((pl) => (
                    <label key={pl.id} className="check">
                      <input
                        type="checkbox"
                        checked={pc.playerIds.includes(pl.id)}
                        onChange={() => togglePlayer(pc.id, pl.id)}
                      />
                      {pl.name}
                    </label>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------- matrix

function MatrixView({ project, update }: { project: Project; update: (fn: (p: Project) => Project) => void }) {
  const toggle = (pieceId: string, playerId: string) =>
    update((p) => togglePieceAssignment(p, pieceId, playerId))

  if (project.players.length === 0 || project.pieces.length === 0) {
    return <p className="hint">Add players and pieces first — then this combined view shows every assignment at a glance.</p>
  }

  return (
    <section>
      <p className="hint">Player ↔ piece assignments in one view. Click a cell to toggle.</p>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Player \ Piece</th>
              {project.pieces.map((pc) => (
                <th key={pc.id}><span>{pc.name}</span><small>{pc.playerIds.length}</small></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {project.players.map((pl) => (
              <tr key={pl.id}>
                <th>
                  {pl.name}{' '}
                  <small>{project.pieces.filter((pc) => pc.playerIds.includes(pl.id)).length}</small>
                </th>
                {project.pieces.map((pc) => {
                  const on = pc.playerIds.includes(pl.id)
                  return (
                    <td
                      key={pc.id}
                      className={on ? 'on' : ''}
                      style={on && pc.color ? { background: pc.color, color: inkFor(pc.color) } : undefined}
                      onClick={() => toggle(pc.id, pl.id)}
                      role="checkbox"
                      aria-checked={on}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(pc.id, pl.id) } }}
                    >
                      {on ? '✕' : ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------- scheduler

function SchedulerView({ project }: { project: Project }) {
  const [selectedPieceIds, setSelectedPieceIds] = useState<Set<string>>(new Set())
  const [selectedCombos, setSelectedCombos] = useState<Set<number>>(new Set())
  const [onlyMaximal, setOnlyMaximal] = useState(true)
  const [shown, setShown] = useState(100)

  const playerName = useMemo(() => new Map(project.players.map((p) => [p.id, p.name])), [project.players])
  const pieceName = useMemo(() => new Map(project.pieces.map((p) => [p.id, p.name])), [project.pieces])
  const pieceById = useMemo(() => new Map(project.pieces.map((p) => [p.id, p])), [project.pieces])

  const togglePiece = (id: string) => {
    setSelectedPieceIds((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSelectedCombos(new Set())
    setShown(100)
  }

  const result = useMemo(() => {
    const pieces = project.pieces.filter((pc) => selectedPieceIds.has(pc.id))
    return findCombinations(pieces, project.players, project.settings.venues)
  }, [project, selectedPieceIds])

  const visible = useMemo(
    () => (onlyMaximal ? result.combinations.filter((c) => c.maximal) : result.combinations),
    [result, onlyMaximal],
  )

  const toggleCombo = (idx: number) =>
    setSelectedCombos((s) => {
      const next = new Set(s)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })

  const exportSelected = () => {
    const combos = visible.filter((_, i) => selectedCombos.has(i))
    exportCombinations(project, combos)
  }

  return (
    <section className="scheduler">
      <div className="panel">
        <div className="panel-head">
          <h3>1 · Select pieces to rehearse</h3>
          <span className="spacer" />
          <button className="link" onClick={() => { setSelectedPieceIds(new Set(project.pieces.map((p) => p.id))); setSelectedCombos(new Set()) }}>
            Select all
          </button>
          <button className="link" onClick={() => { setSelectedPieceIds(new Set()); setSelectedCombos(new Set()) }}>
            Clear
          </button>
        </div>
        {project.pieces.length === 0 && <p className="hint">Add pieces first.</p>}
        <div className="piece-picker">
          {project.pieces.map((pc) => (
            <label key={pc.id} className={selectedPieceIds.has(pc.id) ? 'check picked' : 'check'}>
              <input type="checkbox" checked={selectedPieceIds.has(pc.id)} onChange={() => togglePiece(pc.id)} />
              {pc.name} <small>({pc.playerIds.length})</small>
            </label>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>2 · Concurrent combinations <small>(max {project.settings.venues} venues, most players utilised first)</small></h3>
          <span className="spacer" />
          <label className="check">
            <input type="checkbox" checked={onlyMaximal} onChange={(e) => { setOnlyMaximal(e.target.checked); setSelectedCombos(new Set()) }} />
            Only full groupings (no piece could be added)
          </label>
        </div>
        {selectedPieceIds.size === 0 ? (
          <p className="hint">Select pieces above to see every way they can rehearse at the same time without a player being needed twice.</p>
        ) : visible.length === 0 ? (
          <p className="hint">No conflict-free combination found for this selection.</p>
        ) : (
          <>
            {result.truncated && (
              <p className="warn">Too many combinations — showing the first {result.combinations.length.toLocaleString()} found. Narrow the piece selection.</p>
            )}
            <p className="hint">
              {visible.length.toLocaleString()} combination{visible.length === 1 ? '' : 's'} · tick the ones you want, then export.
            </p>
            <ol className="combos">
              {visible.slice(0, shown).map((c, i) => (
                <li key={i} className={selectedCombos.has(i) ? 'combo selected' : 'combo'}>
                  <label className="combo-row">
                    <input type="checkbox" checked={selectedCombos.has(i)} onChange={() => toggleCombo(i)} />
                    <div className="combo-body">
                      <div className="combo-pieces">
                        {c.pieceIds.map((id) => (
                          <span key={id} className="chip big" style={pieceChipStyle(pieceById.get(id))} title={pieceNames(project, id)}>
                            {pieceName.get(id)}
                          </span>
                        ))}
                      </div>
                      <div className="combo-meta">
                        <strong>{c.playerIds.length}</strong> of {project.players.length} players busy
                        {c.idlePlayerIds.length > 0 ? (
                          <span className="idle"> · idle: {c.idlePlayerIds.map((id) => playerName.get(id)).join(', ')}</span>
                        ) : (
                          <span className="all-busy"> · everyone plays 🎉</span>
                        )}
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ol>
            {visible.length > shown && (
              <button onClick={() => setShown((s) => s + 200)}>Show more ({(visible.length - shown).toLocaleString()} remaining)</button>
            )}
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>3 · Export</h3>
        </div>
        <button className="primary" disabled={selectedCombos.size === 0} onClick={exportSelected}>
          Download {selectedCombos.size || ''} selected combination{selectedCombos.size === 1 ? '' : 's'} as Excel
        </button>
      </div>
    </section>
  )

  function pieceNames(p: Project, pieceId: string): string {
    const pc = p.pieces.find((x) => x.id === pieceId)
    return (pc?.playerIds ?? []).map((id) => playerName.get(id) ?? '?').join(', ')
  }
}

// ------------------------------------------------------------------ seat editor

/**
 * Instrument / section / position editor for one player in one piece.
 * Position must be unique within the piece: a conflicting value is rejected
 * with an inline error instead of being saved.
 */
function SeatEditor({ project, piece, playerId, update }: {
  project: Project
  piece: Piece
  playerId: string
  update: (fn: (p: Project) => Project) => void
}) {
  const instruments = project.sets.find((s) => s.id === INSTRUMENTS_SET_ID)?.items ?? []
  const seat = piece.seats?.[playerId] ?? {}
  const [posText, setPosText] = useState(seat.position?.toString() ?? '')
  const [error, setError] = useState('')

  const setSeat = (patch: Partial<Seat>) =>
    update((p) => ({
      ...p,
      pieces: p.pieces.map((pc) => {
        if (pc.id !== piece.id) return pc
        const merged = { ...(pc.seats?.[playerId] ?? {}), ...patch }
        const clean: Seat = {}
        if (merged.instrumentId) clean.instrumentId = merged.instrumentId
        if (merged.section !== undefined) clean.section = merged.section
        if (merged.position !== undefined) clean.position = merged.position
        const seats = { ...(pc.seats ?? {}) }
        if (Object.keys(clean).length > 0) seats[playerId] = clean
        else delete seats[playerId]
        return { ...pc, seats: Object.keys(seats).length > 0 ? seats : undefined }
      }),
    }))

  const onPosition = (value: string) => {
    setPosText(value)
    if (value.trim() === '') {
      setError('')
      setSeat({ position: undefined })
      return
    }
    const n = parseInt(value, 10)
    if (!Number.isFinite(n)) return
    const holder = piece.playerIds.find((id) => id !== playerId && piece.seats?.[id]?.position === n)
    if (holder) {
      const holderName = project.players.find((pl) => pl.id === holder)?.name ?? 'another player'
      setError(`Position ${n} is already taken by ${holderName} in this piece`)
      return
    }
    setError('')
    setSeat({ position: n })
  }

  return (
    <>
      <td>
        <select
          value={seat.instrumentId ?? ''}
          onChange={(e) => setSeat({ instrumentId: e.target.value || undefined })}
        >
          <option value="">—</option>
          {instruments.map((it) => (
            <option key={it.id} value={it.id}>{it.code} · {it.label}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="number"
          min={1}
          className="seat-num"
          value={seat.section ?? ''}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10)
            setSeat({ section: Number.isFinite(n) ? n : undefined })
          }}
        />
      </td>
      <td>
        <input
          type="number"
          min={1}
          className={error ? 'seat-num invalid' : 'seat-num'}
          value={posText}
          onChange={(e) => onPosition(e.target.value)}
          onBlur={() => { if (error) { setPosText(seat.position?.toString() ?? ''); setError('') } }}
        />
        {error && <div className="seat-error">{error}</div>}
      </td>
    </>
  )
}

// ----------------------------------------------------------------- detail pages

function PieceDetailView({ project, pieceId, update, onBack }: {
  project: Project
  pieceId: string
  update: (fn: (p: Project) => Project) => void
  onBack: () => void
}) {
  const piece = project.pieces.find((pc) => pc.id === pieceId)
  if (!piece) {
    return <section><button className="link" onClick={onBack}>← Back</button><p className="hint">This piece no longer exists.</p></section>
  }
  const players = project.players.filter((pl) => piece.playerIds.includes(pl.id))
  return (
    <section>
      <div className="detail-head">
        <button className="link" onClick={onBack}>← Back to pieces</button>
        <h2>
          {piece.color && <span className="dot" style={{ background: piece.color, cursor: 'default' }} />}
          {piece.name}
        </h2>
        <p className="hint">
          Assign each player an instrument, section and position for this piece. Section and position may stay
          empty; a position must be unique within the piece.
        </p>
      </div>
      {players.length === 0 ? (
        <p className="hint">No players assigned to this piece yet — assign them in the Pieces tab or the Assignments matrix.</p>
      ) : (
        <table className="seat-table">
          <thead>
            <tr><th>Player</th><th>Instrument</th><th>Section</th><th>Position</th></tr>
          </thead>
          <tbody>
            {players.map((pl) => (
              <tr key={pl.id}>
                <th>{pl.name}</th>
                <SeatEditor project={project} piece={piece} playerId={pl.id} update={update} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function PlayerDetailView({ project, playerId, update, onBack }: {
  project: Project
  playerId: string
  update: (fn: (p: Project) => Project) => void
  onBack: () => void
}) {
  const player = project.players.find((pl) => pl.id === playerId)
  if (!player) {
    return <section><button className="link" onClick={onBack}>← Back</button><p className="hint">This player no longer exists.</p></section>
  }
  const pieces = project.pieces.filter((pc) => pc.playerIds.includes(playerId))
  return (
    <section>
      <div className="detail-head">
        <button className="link" onClick={onBack}>← Back to players</button>
        <h2>{player.name}</h2>
        <p className="hint">
          {player.name}&apos;s instrument, section and position per piece — they may differ from piece to piece.
          A position must be unique within its piece.
        </p>
      </div>
      {pieces.length === 0 ? (
        <p className="hint">{player.name} is not assigned to any piece yet.</p>
      ) : (
        <table className="seat-table">
          <thead>
            <tr><th>Piece</th><th>Instrument</th><th>Section</th><th>Position</th></tr>
          </thead>
          <tbody>
            {pieces.map((pc) => (
              <tr key={pc.id}>
                <th><span className="chip" style={pieceChipStyle(pc)}>{pc.name}</span></th>
                <SeatEditor project={project} piece={pc} playerId={playerId} update={update} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- configuration

function ConfigView({ project, update }: { project: Project; update: (fn: (p: Project) => Project) => void }) {
  const [newSetName, setNewSetName] = useState('')

  const addSet = () => {
    const name = newSetName.trim()
    if (!name) return
    update((p) => ({ ...p, sets: [...p.sets, { id: newId(), name, items: [] }] }))
    setNewSetName('')
  }

  return (
    <section className="config">
      <p className="hint">
        Sets are reusable lists used elsewhere in the app — the Instruments set feeds the instrument choice on
        the piece and player detail pages.
      </p>
      {project.sets.map((set) => (
        <SetCard key={set.id} setId={set.id} project={project} update={update} />
      ))}
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); addSet() }}>
        <input placeholder="New set name…" value={newSetName} onChange={(e) => setNewSetName(e.target.value)} />
        <button type="submit" disabled={!newSetName.trim()}>Add set</button>
      </form>
    </section>
  )
}

function SetCard({ setId, project, update }: {
  setId: string
  project: Project
  update: (fn: (p: Project) => Project) => void
}) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const set = project.sets.find((s) => s.id === setId)
  if (!set) return null

  const addItem = () => {
    const c = code.trim()
    const l = label.trim()
    if (!c || !l) return
    if (set.items.some((it) => it.code.toLowerCase() === c.toLowerCase())) return
    update((p) => ({
      ...p,
      sets: p.sets.map((s) => (s.id === setId ? { ...s, items: [...s.items, { id: newId(), code: c, label: l }] } : s)),
    }))
    setCode('')
    setLabel('')
  }

  const removeItem = (itemId: string) =>
    update((p) => ({
      ...p,
      sets: p.sets.map((s) => (s.id === setId ? { ...s, items: s.items.filter((it) => it.id !== itemId) } : s)),
      // drop dangling references from seats when an instrument is deleted
      pieces: setId === INSTRUMENTS_SET_ID
        ? p.pieces.map((pc) => {
            if (!pc.seats) return pc
            const seats: Record<string, Seat> = {}
            for (const [playerId, seat] of Object.entries(pc.seats)) {
              const cleaned = seat.instrumentId === itemId ? { ...seat, instrumentId: undefined } : seat
              if (cleaned.instrumentId || cleaned.section !== undefined || cleaned.position !== undefined) {
                seats[playerId] = cleaned
              }
            }
            return { ...pc, seats: Object.keys(seats).length > 0 ? seats : undefined }
          })
        : p.pieces,
    }))

  const removeSet = () => update((p) => ({ ...p, sets: p.sets.filter((s) => s.id !== setId) }))

  return (
    <div className="card">
      <div className="card-head">
        <strong>{set.name}</strong>
        <span className="hint">{set.items.length} item{set.items.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        {set.id !== INSTRUMENTS_SET_ID && (
          <button className="link danger" onClick={removeSet}>Delete set</button>
        )}
      </div>
      <table className="set-table">
        <tbody>
          {set.items.map((it) => (
            <tr key={it.id}>
              <td className="set-code">{it.code}</td>
              <td>{it.label}</td>
              <td className="set-actions">
                <button className="link danger" onClick={() => removeItem(it.id)} aria-label={`Delete ${it.label}`}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); addItem() }}>
        <input className="code-input" placeholder="Code (e.g. fg)" value={code} onChange={(e) => setCode(e.target.value)} />
        <input placeholder="Name (e.g. bassoon)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" disabled={!code.trim() || !label.trim()}>Add</button>
      </form>
    </div>
  )
}

// -------------------------------------------------------------------- settings

function SettingsView({ project, update }: { project: Project; update: (fn: (p: Project) => Project) => void }) {
  const s = project.settings
  const set = (patch: Partial<typeof s>) => update((p) => ({ ...p, settings: { ...p.settings, ...patch } }))
  const num = (v: string, fallback: number, min = 1) => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n >= min ? n : fallback
  }
  return (
    <section className="settings">
      <label>
        Rehearsal venues (max concurrent pieces)
        <input type="number" min={1} value={s.venues} onChange={(e) => set({ venues: num(e.target.value, s.venues) })} />
      </label>
      <label>
        Session duration in minutes (incl. 10&nbsp;min break)
        <input type="number" min={1} value={s.sessionMinutes} onChange={(e) => set({ sessionMinutes: num(e.target.value, s.sessionMinutes) })} />
      </label>
      <label>
        Sessions in the morning
        <input type="number" min={0} value={s.morningSessions} onChange={(e) => set({ morningSessions: num(e.target.value, s.morningSessions, 0) })} />
      </label>
      <label>
        Sessions in the afternoon
        <input type="number" min={0} value={s.afternoonSessions} onChange={(e) => set({ afternoonSessions: num(e.target.value, s.afternoonSessions, 0) })} />
      </label>
      <p className="hint">
        {s.morningSessions + s.afternoonSessions} sessions/day ·{' '}
        {((s.morningSessions + s.afternoonSessions) * s.sessionMinutes / 60).toFixed(1)} h of rehearsal per day
      </p>
    </section>
  )
}

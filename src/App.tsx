import { useCallback, useEffect, useMemo, useState, type ClipboardEvent, type CSSProperties } from 'react'
import { createProject, INSTRUMENTS_SET_ID, newId, type Piece, type Project, type Seat } from './types'
import { findCombinations, type Combination } from './combinations'
import { inkFor, PASTEL_PALETTE } from './colors'
import { exportCombinationPlan, exportDayPlan } from './excel'
import { overbookedPlayers, planDay, type DayPlan } from './dayplan'
import {
  autosave,
  connectFolder,
  isTouchWebKit,
  listProjectFiles,
  loadAutosave,
  loadMirror,
  loadProjectFromFolder,
  requestPersistentStorage,
  restoreFolder,
  saveProjectFallback,
  saveProjectToFolder,
  supportsFileSystemAccess,
  uploadProject,
} from './storage'
import './App.css'

type Tab = 'players' | 'pieces' | 'matrix' | 'scheduler' | 'config'

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
            {tab === 'scheduler' && <SchedulerView project={project} update={update} />}
            {tab === 'config' && <ConfigView project={project} update={update} />}
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
  const [folderHelp, setFolderHelp] = useState(false)

  const confirmDiscard = () =>
    !dirty || window.confirm('You have unsaved changes — discard them?')

  const save = async () => {
    try {
      if (folder) {
        const name = await saveProjectToFolder(folder, project)
        flash(`Saved ${name} to “${folder.name}”`)
        onSaved()
        return
      }
      const outcome = await saveProjectFallback(project)
      if (outcome === 'cancelled') {
        flash('Save cancelled')
        return
      }
      flash(outcome === 'shared' ? 'Project file shared — “Save to Files” stores it in a folder' : 'Project downloaded')
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
      {supportsFileSystemAccess ? (
        <button onClick={connect} title="Connect a folder on your computer to save/load projects">
          {folder ? `📁 ${folder.name}` : '📁 Connect folder'}
        </button>
      ) : (
        <button onClick={() => setFolderHelp(true)} title="How saving works in this browser">
          📁 Files?
        </button>
      )}
      {folderHelp && (
        <div className="modal-backdrop" onClick={() => setFolderHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Saving in this browser</h3>
            <p>
              Connecting a folder needs the File System Access API, which this browser doesn&apos;t
              provide — on iPhone and iPad no browser does, so a permanent folder connection isn&apos;t
              possible there.
            </p>
            {isTouchWebKit ? (
              <p>
                Instead, <strong>Save</strong> opens the share sheet with the project file: choose{' '}
                <strong>Save to Files</strong> and pick any folder in iCloud Drive or On My
                iPhone/iPad. <strong>Open</strong> loads the file back from the Files app. Saving to
                iCloud Drive also makes the project available on your computer.
              </p>
            ) : (
              <p>
                Instead, <strong>Save</strong> downloads the project file and <strong>Open</strong>{' '}
                loads it via a file picker. For the folder connection, use a Chromium browser such as
                Chrome or Edge on desktop.
              </p>
            )}
            <button onClick={() => setFolderHelp(false)}>Got it</button>
          </div>
        </div>
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

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

/** Pastel background + complementary ink for a colour-coded number, if configured. */
function numberColorStyle(project: Project, n: number | undefined): CSSProperties | undefined {
  if (n === undefined) return undefined
  const color = project.numberColors[String(n)]
  return color ? { background: color, color: inkFor(color) } : undefined
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
        {[...project.players].sort(byName).map((pl) => {
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
        {[...project.pieces].sort(byName).map((pc) => {
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

function SchedulerView({ project, update }: { project: Project; update: (fn: (p: Project) => Project) => void }) {
  const [selectedPieceIds, setSelectedPieceIds] = useState<Set<string>>(new Set())
  const [selectedCombo, setSelectedCombo] = useState<Combination | null>(null)
  const [dayPlan, setDayPlan] = useState<DayPlan | null>(null)
  const [daySeed, setDaySeed] = useState(1)
  const [reviewDay, setReviewDay] = useState(false)
  const [onlyMaximal, setOnlyMaximal] = useState(true)
  const [shown, setShown] = useState(100)

  const sessionCount = project.settings.morningSessions + project.settings.afternoonSessions
  const capacity = sessionCount * project.settings.venues

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
    setSelectedCombo(null)
    setDayPlan(null)
    setReviewDay(false)
    setShown(100)
  }

  const selectedPieces = useMemo(
    () => project.pieces.filter((pc) => selectedPieceIds.has(pc.id)),
    [project.pieces, selectedPieceIds],
  )

  const makePlan = (seed: number) => {
    setDaySeed(seed)
    setDayPlan(planDay(selectedPieces, project.players, project.settings.venues, sessionCount, seed))
    setReviewDay(false)
  }

  const result = useMemo(() => {
    const pieces = project.pieces.filter((pc) => selectedPieceIds.has(pc.id))
    return findCombinations(pieces, project.players, project.settings.venues)
  }, [project, selectedPieceIds])

  const visible = useMemo(
    () => (onlyMaximal ? result.combinations.filter((c) => c.maximal) : result.combinations),
    [result, onlyMaximal],
  )

  if (reviewDay && dayPlan) {
    return (
      <DayPlanDetailView
        project={project}
        plan={dayPlan}
        update={update}
        onBack={() => setReviewDay(false)}
      />
    )
  }

  if (selectedCombo) {
    return (
      <CombinationDetailView
        project={project}
        combination={selectedCombo}
        update={update}
        onBack={() => setSelectedCombo(null)}
      />
    )
  }

  return (
    <section className="scheduler">
      <div className="panel">
        <div className="panel-head">
          <h3>1 · Select pieces to rehearse</h3>
          <span className="spacer" />
          <button className="link" onClick={() => setSelectedPieceIds(new Set(project.pieces.map((p) => p.id)))}>
            Select all
          </button>
          <button className="link" onClick={() => setSelectedPieceIds(new Set())}>
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
          <h3>
            2 · Day plan{' '}
            <small>({sessionCount} sessions × {project.settings.venues} venues = room for {capacity} pieces)</small>
          </h3>
          <span className="spacer" />
          {dayPlan && (
            <button onClick={() => makePlan(daySeed + 1)}>Try another arrangement</button>
          )}
          <button className="primary" onClick={() => makePlan(daySeed)} disabled={selectedPieceIds.size === 0}>
            Plan the day
          </button>
        </div>
        {selectedPieceIds.size > capacity && (
          <p className="warn">
            {selectedPieceIds.size} pieces selected but the day only has room for {capacity} —
            at least {selectedPieceIds.size - capacity} will stay unplaced.
          </p>
        )}
        {!dayPlan ? (
          <p className="hint">
            Distributes every selected piece over the day&apos;s sessions so that no player is needed in two
            venues of the same session. Each piece is rehearsed once.
          </p>
        ) : (
          <>
            {!dayPlan.complete && (
              <p className="warn">
                Not all pieces fit: {dayPlan.unplacedPieceIds.map((id) => pieceName.get(id) ?? '?').join(', ')}{' '}
                stay unplaced.
                {overbookedPlayers(selectedPieces, sessionCount).map(({ playerId, count }) => (
                  <span key={playerId}>
                    {' '}{playerName.get(playerId) ?? '?'} plays in {count} pieces but the day has only{' '}
                    {sessionCount} sessions.
                  </span>
                ))}
              </p>
            )}
            <ol className="combos">
              {dayPlan.sessions.map((session, i) => (
                <li key={i} className="combo">
                  <div className="combo-row static">
                    <div className="combo-body">
                      <div className="session-title">
                        <strong>Session {i + 1}</strong>{' '}
                        <small className="hint">{i < project.settings.morningSessions ? 'morning' : 'afternoon'}</small>
                      </div>
                      {session.pieceIds.length === 0 ? (
                        <div className="combo-meta">— free —</div>
                      ) : (
                        <>
                          <div className="combo-pieces">
                            {session.pieceIds.map((id) => (
                              <span key={id} className="chip big" style={pieceChipStyle(pieceById.get(id))}>
                                {pieceName.get(id)}
                              </span>
                            ))}
                          </div>
                          <div className="combo-meta">
                            <strong>{session.playerIds.length}</strong> of {project.players.length} players busy
                            {session.idlePlayerIds.length > 0 ? (
                              <span className="idle"> · idle: {session.idlePlayerIds.map((id) => playerName.get(id)).join(', ')}</span>
                            ) : (
                              <span className="all-busy"> · everyone plays 🎉</span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <div className="detail-actions">
              <button className="primary" onClick={() => setReviewDay(true)}>
                Review day plan →
              </button>
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>3 · Single-session combinations <small>(max {project.settings.venues} venues, most players utilised first)</small></h3>
          <span className="spacer" />
          <label className="check">
            <input type="checkbox" checked={onlyMaximal} onChange={(e) => setOnlyMaximal(e.target.checked)} />
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
              {visible.length.toLocaleString()} combination{visible.length === 1 ? '' : 's'} · click one to review venues,
              seats and idle activities, then download it.
            </p>
            <ol className="combos">
              {visible.slice(0, shown).map((c, i) => (
                <li key={i} className="combo">
                  <button className="combo-row" onClick={() => setSelectedCombo(c)}>
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
                    <span className="combo-open">Review →</span>
                  </button>
                </li>
              ))}
            </ol>
            {visible.length > shown && (
              <button onClick={() => setShown((s) => s + 200)}>Show more ({(visible.length - shown).toLocaleString()} remaining)</button>
            )}
          </>
        )}
      </div>

    </section>
  )

  function pieceNames(p: Project, pieceId: string): string {
    const pc = p.pieces.find((x) => x.id === pieceId)
    return (pc?.playerIds ?? []).map((id) => playerName.get(id) ?? '?').join(', ')
  }
}

// ------------------------------------------------------- combination detail

/**
 * Review page for the whole day plan: every session with its venues and
 * editable seats, idle players with activity texts per session, and the
 * day-plan Excel download once everything looks right.
 */
function DayPlanDetailView({ project, plan, update, onBack }: {
  project: Project
  plan: DayPlan
  update: (fn: (p: Project) => Project) => void
  onBack: () => void
}) {
  const [venueBySession, setVenueBySession] = useState<Record<number, Record<string, number>>>(() =>
    Object.fromEntries(
      plan.sessions.map((s, i) => [i, Object.fromEntries(s.pieceIds.map((id, j) => [id, j + 1]))]),
    ),
  )
  const [activities, setActivities] = useState<Record<number, Record<string, string>>>({})

  const playerName = useMemo(() => new Map(project.players.map((p) => [p.id, p.name])), [project.players])
  const morning = project.settings.morningSessions

  const moveToVenue = (sessionIdx: number) => (pieceId: string, venue: number) =>
    setVenueBySession((all) => {
      const v = all[sessionIdx] ?? {}
      const occupant = Object.keys(v).find((id) => v[id] === venue)
      const next = { ...v, [pieceId]: venue }
      if (occupant && occupant !== pieceId) next[occupant] = v[pieceId]
      return { ...all, [sessionIdx]: next }
    })

  const setActivity = (sessionIdx: number, playerId: string, text: string) =>
    setActivities((all) => ({ ...all, [sessionIdx]: { ...all[sessionIdx], [playerId]: text } }))

  const missingSeats = countMissingSeats(project, [...new Set(plan.sessions.flatMap((s) => s.pieceIds))])
  const busyTotal = plan.sessions.reduce((acc, s) => acc + s.playerIds.length, 0)

  return (
    <section>
      <div className="detail-head">
        <button className="link" onClick={onBack}>← Back to scheduler</button>
        <h2>Day plan</h2>
        <p className="hint">
          {plan.sessions.length} sessions × {project.settings.venues} venues ·{' '}
          {project.settings.sessionMinutes} min per session · on average{' '}
          {(busyTotal / plan.sessions.length).toFixed(1)} of {project.players.length} players busy per session.
          Venue numbers can be swapped freely within a session — they don&apos;t affect the conflict constraints.
        </p>
        {!plan.complete && (
          <p className="warn">
            Unplaced pieces: {plan.unplacedPieceIds.map((id) => project.pieces.find((pc) => pc.id === id)?.name ?? '?').join(', ')}
          </p>
        )}
        {missingSeats > 0 && (
          <p className="warn">
            {missingSeats} seat{missingSeats === 1 ? ' is' : 's are'} missing an instrument or position —
            highlighted below, fix them right here.
          </p>
        )}
      </div>

      {plan.sessions.map((session, i) => (
        <div key={i} className="day-session">
          <h3 className="day-session-title">
            Session {i + 1} <small className="hint">{i < morning ? 'morning' : 'afternoon'}</small>
            {session.pieceIds.length === 0 && <small className="hint"> · free</small>}
          </h3>
          {session.pieceIds.length > 0 && (
            <>
              <SessionVenues
                project={project}
                pieceIds={session.pieceIds}
                venueOf={venueBySession[i] ?? {}}
                onMove={moveToVenue(i)}
                update={update}
                hideEmpty
              />
              <div className="panel">
                <div className="panel-head"><h3>Idle players</h3></div>
                {session.idlePlayerIds.length === 0 ? (
                  <p className="hint">Everyone plays in this session 🎉</p>
                ) : (
                  <table className="seat-table">
                    <thead>
                      <tr><th>Player</th><th>Activity</th></tr>
                    </thead>
                    <tbody>
                      {session.idlePlayerIds.map((id) => (
                        <tr key={id}>
                          <th>{playerName.get(id) ?? '?'}</th>
                          <td>
                            <input
                              className="activity-input"
                              placeholder="e.g. self study, coaching…"
                              value={activities[i]?.[id] ?? ''}
                              onChange={(e) => setActivity(i, id, e.target.value)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      ))}

      <div className="detail-actions">
        <button
          className="primary"
          onClick={() => exportDayPlan(project, plan, morning, { venueBySession, activities })}
        >
          Download day plan as Excel
        </button>
      </div>
    </section>
  )
}

/** How many players in these pieces are missing an instrument or a position. */
function countMissingSeats(project: Project, pieceIds: string[]): number {
  return pieceIds.reduce((acc, pieceId) => {
    const piece = project.pieces.find((pc) => pc.id === pieceId)
    if (!piece) return acc
    return acc + piece.playerIds.filter((id) => {
      const seat = piece.seats?.[id]
      return !seat?.instrumentId || seat?.position === undefined
    }).length
  }, 0)
}

/** The venue panels of one session: pieces with editable seats, movable between venues. */
function SessionVenues({ project, pieceIds, venueOf, onMove, update, hideEmpty = false }: {
  project: Project
  pieceIds: string[]
  venueOf: Record<string, number>
  onMove: (pieceId: string, venue: number) => void
  update: (fn: (p: Project) => Project) => void
  hideEmpty?: boolean
}) {
  const venues = project.settings.venues
  return (
    <div className="venues">
      {Array.from({ length: venues }, (_, i) => i + 1).map((venue) => {
        const pieceId = pieceIds.find((id) => venueOf[id] === venue)
        const piece = pieceId ? project.pieces.find((pc) => pc.id === pieceId) : undefined
        if (!piece && hideEmpty) return null
        return (
          <div key={venue} className="panel venue-panel">
            <div className="panel-head">
              <h3>Venue {venue}</h3>
              {piece && (
                <>
                  <span className="chip big" style={pieceChipStyle(piece)}>{piece.name}</span>
                  <span className="spacer" />
                  <label className="venue-move">
                    Move to
                    <select value={venue} onChange={(e) => onMove(piece.id, parseInt(e.target.value, 10))}>
                      {Array.from({ length: venues }, (_, i) => i + 1).map((v) => (
                        <option key={v} value={v}>Venue {v}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            {!piece ? (
              <p className="hint">No piece in this venue.</p>
            ) : piece.playerIds.length === 0 ? (
              <p className="hint">No players assigned to this piece.</p>
            ) : (
              <table className="seat-table">
                <thead>
                  <tr><th>Player</th><th>Instrument</th><th>Section</th><th>Position</th></tr>
                </thead>
                <tbody>
                  {project.players.filter((pl) => piece.playerIds.includes(pl.id)).map((pl) => {
                    const seat = piece.seats?.[pl.id]
                    const missing = !seat?.instrumentId || seat?.position === undefined
                    return (
                      <tr key={pl.id} className={missing ? 'missing-seat' : ''}>
                        <th>
                          {pl.name}
                          {missing && <span className="missing-mark" title="Instrument or position missing"> ⚠</span>}
                        </th>
                        <SeatEditor project={project} piece={piece} playerId={pl.id} update={update} />
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Review page for one combination: pieces spread over venues (venue numbers
 * are swappable — they never affect the conflict constraints), every playing
 * player's seat with missing instrument/position highlighted and editable,
 * idle players with a free activity text, and the Excel download.
 */
function CombinationDetailView({ project, combination, update, onBack, title = 'Session plan', backLabel = '← Back to combinations' }: {
  project: Project
  combination: Combination
  update: (fn: (p: Project) => Project) => void
  onBack: () => void
  title?: string
  backLabel?: string
}) {
  const [venueOf, setVenueOf] = useState<Record<string, number>>(() =>
    Object.fromEntries(combination.pieceIds.map((id, i) => [id, i + 1])),
  )
  const [activities, setActivities] = useState<Record<string, string>>({})

  const playerName = useMemo(() => new Map(project.players.map((p) => [p.id, p.name])), [project.players])

  // Assigning a piece to an occupied venue swaps the two pieces.
  const moveToVenue = (pieceId: string, venue: number) =>
    setVenueOf((v) => {
      const occupant = Object.keys(v).find((id) => v[id] === venue)
      const next = { ...v, [pieceId]: venue }
      if (occupant && occupant !== pieceId) next[occupant] = v[pieceId]
      return next
    })

  const download = () =>
    exportCombinationPlan(project, { combination, venueOf, activities })

  const missingSeats = countMissingSeats(project, combination.pieceIds)

  return (
    <section>
      <div className="detail-head">
        <button className="link" onClick={onBack}>{backLabel}</button>
        <h2>{title}</h2>
        <p className="hint">
          One {project.settings.sessionMinutes} min session · {combination.playerIds.length} of{' '}
          {project.players.length} players busy. Venue numbers can be swapped freely — they don&apos;t affect
          the conflict constraints.
        </p>
        {missingSeats > 0 && (
          <p className="warn">
            {missingSeats} seat{missingSeats === 1 ? ' is' : 's are'} missing an instrument or position —
            highlighted below, fix them right here.
          </p>
        )}
      </div>

      <SessionVenues project={project} pieceIds={combination.pieceIds} venueOf={venueOf} onMove={moveToVenue} update={update} />

      <div className="panel">
        <div className="panel-head">
          <h3>Idle players</h3>
        </div>
        {combination.idlePlayerIds.length === 0 ? (
          <p className="hint">Everyone plays in this combination 🎉</p>
        ) : (
          <table className="seat-table">
            <thead>
              <tr><th>Player</th><th>Activity</th></tr>
            </thead>
            <tbody>
              {combination.idlePlayerIds.map((id) => (
                <tr key={id}>
                  <th>{playerName.get(id) ?? '?'}</th>
                  <td>
                    <input
                      className="activity-input"
                      placeholder="e.g. self study, coaching…"
                      value={activities[id] ?? ''}
                      onChange={(e) => setActivities((a) => ({ ...a, [id]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="detail-actions">
        <button className="primary" onClick={download}>Download session plan as Excel</button>
      </div>
    </section>
  )
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
          style={numberColorStyle(project, seat.section)}
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
          style={numberColorStyle(project, seat.position)}
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
      <h3 className="config-heading">Rehearsal settings</h3>
      <div className="card">
        <SettingsView project={project} update={update} />
      </div>

      <h3 className="config-heading">Sets</h3>
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

      <h3 className="config-heading">Number colours</h3>
      <NumberColorsCard project={project} update={update} />
    </section>
  )
}

function NumberColorsCard({ project, update }: { project: Project; update: (fn: (p: Project) => Project) => void }) {
  const [numText, setNumText] = useState('')
  const n = parseInt(numText, 10)
  const validNumber = Number.isFinite(n) && n >= 0

  const setColor = (color: string) => {
    if (!validNumber) return
    update((p) => ({ ...p, numberColors: { ...p.numberColors, [String(n)]: color } }))
    setNumText('')
  }

  const remove = (key: string) =>
    update((p) => {
      const numberColors = { ...p.numberColors }
      delete numberColors[key]
      return { ...p, numberColors }
    })

  const entries = Object.entries(project.numberColors).sort((a, b) => Number(a[0]) - Number(b[0]))

  return (
    <div className="card">
      <p className="hint">
        Give a number a colour and every Section and Position value shows it — for readers who
        associate numbers with colours.
      </p>
      {entries.length > 0 && (
        <div className="num-list">
          {entries.map(([key, color]) => (
            <span key={key} className="num-badge" style={{ background: color, color: inkFor(color) }}>
              {key}
              <button className="num-remove" aria-label={`Remove colour for ${key}`} onClick={() => remove(key)}>✕</button>
            </span>
          ))}
        </div>
      )}
      <div className="add-row">
        <input
          type="number"
          min={0}
          className="code-input"
          placeholder="Number…"
          value={numText}
          onChange={(e) => setNumText(e.target.value)}
        />
        <div className="palette inline-palette">
          {PASTEL_PALETTE.map((c) => (
            <button
              key={c}
              className="swatch"
              style={{ background: c }}
              disabled={!validNumber}
              title={validNumber ? `Colour ${n} in ${c}` : 'Enter a number first'}
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>
    </div>
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

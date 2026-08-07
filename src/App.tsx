import { useCallback, useEffect, useMemo, useState } from 'react'
import { createProject, newId, type Project } from './types'
import { findCombinations } from './combinations'
import { exportCombinations } from './excel'
import {
  autosave,
  connectFolder,
  downloadProject,
  listProjectFiles,
  loadAutosave,
  loadProjectFromFolder,
  restoreFolder,
  saveProjectToFolder,
  supportsFileSystemAccess,
  uploadProject,
} from './storage'
import './App.css'

type Tab = 'players' | 'pieces' | 'matrix' | 'scheduler' | 'settings'

export default function App() {
  const [project, setProject] = useState<Project | null>(() => loadAutosave())
  const [tab, setTab] = useState<Tab>('players')
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (project) autosave(project)
  }, [project])

  useEffect(() => {
    if (supportsFileSystemAccess) restoreFolder().then((h) => h && setFolder(h))
  }, [])

  const flash = useCallback((msg: string) => {
    setStatus(msg)
    window.setTimeout(() => setStatus((s) => (s === msg ? '' : s)), 4000)
  }, [])

  const update = useCallback((fn: (p: Project) => Project) => {
    setProject((p) => (p ? fn(p) : p))
  }, [])

  if (!project) {
    return <StartScreen onCreate={(name) => setProject(createProject(name))} onOpen={setProject} />
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
            onLoaded={(p) => { setProject(p); flash(`Loaded “${p.name}”`) }}
            onNew={() => { setProject(createProject('New project')); setTab('players') }}
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
            ['settings', 'Settings'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === 'players' && <PlayersView project={project} update={update} />}
        {tab === 'pieces' && <PiecesView project={project} update={update} />}
        {tab === 'matrix' && <MatrixView project={project} update={update} />}
        {tab === 'scheduler' && <SchedulerView project={project} />}
        {tab === 'settings' && <SettingsView project={project} update={update} />}
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
  project, folder, setFolder, onLoaded, onNew, flash,
}: {
  project: Project
  folder: FileSystemDirectoryHandle | null
  setFolder: (h: FileSystemDirectoryHandle | null) => void
  onLoaded: (p: Project) => void
  onNew: () => void
  flash: (msg: string) => void
}) {
  const [files, setFiles] = useState<string[] | null>(null)

  const save = async () => {
    try {
      if (folder) {
        const name = await saveProjectToFolder(folder, project)
        flash(`Saved ${name} to “${folder.name}”`)
      } else {
        downloadProject(project)
        flash('Project downloaded')
      }
    } catch (e) {
      flash(`Save failed: ${(e as Error).message}`)
    }
  }

  const open = async () => {
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
      <button onClick={onNew}>New</button>
      <button onClick={open}>Open</button>
      <button className="primary" onClick={save}>Save</button>
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

// --------------------------------------------------------------------- players

function PlayersView({ project, update }: { project: Project; update: (fn: (p: Project) => Project) => void }) {
  const [name, setName] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const add = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    update((p) => ({ ...p, players: [...p.players, { id: newId(), name: trimmed }] }))
    setName('')
  }

  const remove = (id: string) =>
    update((p) => ({
      ...p,
      players: p.players.filter((pl) => pl.id !== id),
      pieces: p.pieces.map((pc) => ({ ...pc, playerIds: pc.playerIds.filter((pid) => pid !== id) })),
    }))

  const togglePiece = (playerId: string, pieceId: string) =>
    update((p) => ({
      ...p,
      pieces: p.pieces.map((pc) =>
        pc.id === pieceId
          ? {
              ...pc,
              playerIds: pc.playerIds.includes(playerId)
                ? pc.playerIds.filter((id) => id !== playerId)
                : [...pc.playerIds, playerId],
            }
          : pc,
      ),
    }))

  return (
    <section>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input placeholder="Add player (first name)…" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={!name.trim()}>Add player</button>
      </form>
      {project.players.length === 0 && <p className="hint">No players yet. Add the first one above.</p>}
      <ul className="cards">
        {project.players.map((pl) => {
          const pieces = project.pieces.filter((pc) => pc.playerIds.includes(pl.id))
          const open = openId === pl.id
          return (
            <li key={pl.id} className="card">
              <div className="card-head">
                <strong>{pl.name}</strong>
                <span className="chips">
                  {pieces.map((pc) => <span key={pc.id} className="chip">{pc.name}</span>)}
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

function PiecesView({ project, update }: { project: Project; update: (fn: (p: Project) => Project) => void }) {
  const [name, setName] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const add = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    update((p) => ({ ...p, pieces: [...p.pieces, { id: newId(), name: trimmed, playerIds: [] }] }))
    setName('')
  }

  const remove = (id: string) => update((p) => ({ ...p, pieces: p.pieces.filter((pc) => pc.id !== id) }))

  const togglePlayer = (pieceId: string, playerId: string) =>
    update((p) => ({
      ...p,
      pieces: p.pieces.map((pc) =>
        pc.id === pieceId
          ? {
              ...pc,
              playerIds: pc.playerIds.includes(playerId)
                ? pc.playerIds.filter((id) => id !== playerId)
                : [...pc.playerIds, playerId],
            }
          : pc,
      ),
    }))

  return (
    <section>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input placeholder="Add piece…" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={!name.trim()}>Add piece</button>
      </form>
      {project.pieces.length === 0 && <p className="hint">No pieces yet. Add the first one above.</p>}
      <ul className="cards">
        {project.pieces.map((pc) => {
          const open = openId === pc.id
          const players = project.players.filter((pl) => pc.playerIds.includes(pl.id))
          return (
            <li key={pc.id} className="card">
              <div className="card-head">
                <strong>{pc.name}</strong>
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
    update((p) => ({
      ...p,
      pieces: p.pieces.map((pc) =>
        pc.id === pieceId
          ? {
              ...pc,
              playerIds: pc.playerIds.includes(playerId)
                ? pc.playerIds.filter((id) => id !== playerId)
                : [...pc.playerIds, playerId],
            }
          : pc,
      ),
    }))

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
                          <span key={id} className="chip big" title={pieceNames(project, id)}>
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

export interface Player {
  id: string
  name: string
}

export interface Piece {
  id: string
  name: string
  playerIds: string[]
}

export interface ProjectSettings {
  /** Maximum number of rehearsal venues, i.e. pieces that can rehearse concurrently. */
  venues: number
  /** Duration of one rehearsal block ("session") in minutes, incl. the 10min break. */
  sessionMinutes: number
  morningSessions: number
  afternoonSessions: number
}

export interface Project {
  formatVersion: 1
  name: string
  settings: ProjectSettings
  players: Player[]
  pieces: Piece[]
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  venues: 4,
  sessionMinutes: 50,
  morningSessions: 4,
  afternoonSessions: 3,
}

export function createProject(name: string): Project {
  return {
    formatVersion: 1,
    name,
    settings: { ...DEFAULT_SETTINGS },
    players: [],
    pieces: [],
  }
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** Validate + normalise a parsed JSON value into a Project, or throw. */
export function parseProject(data: unknown): Project {
  if (typeof data !== 'object' || data === null) throw new Error('Not a project file')
  const d = data as Record<string, unknown>
  if (typeof d.name !== 'string' || !Array.isArray(d.players) || !Array.isArray(d.pieces)) {
    throw new Error('Not a valid project file')
  }
  const settings = { ...DEFAULT_SETTINGS, ...(typeof d.settings === 'object' && d.settings !== null ? d.settings : {}) } as ProjectSettings
  const players: Player[] = (d.players as unknown[])
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({ id: String(p.id ?? newId()), name: String(p.name ?? '') }))
  const playerIdSet = new Set(players.map((p) => p.id))
  const pieces: Piece[] = (d.pieces as unknown[])
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({
      id: String(p.id ?? newId()),
      name: String(p.name ?? ''),
      playerIds: Array.isArray(p.playerIds) ? p.playerIds.map(String).filter((id) => playerIdSet.has(id)) : [],
    }))
  return { formatVersion: 1, name: d.name, settings, players, pieces }
}

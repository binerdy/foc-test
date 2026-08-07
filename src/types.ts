export interface Player {
  id: string
  name: string
}

/** One entry of a configuration set, e.g. an instrument. */
export interface SetItem {
  id: string
  code: string
  label: string
}

/** A named configuration set (Configuration tab), e.g. "Instruments". */
export interface ConfigSet {
  id: string
  name: string
  items: SetItem[]
}

/** A player's seat in one specific piece. All fields optional except that
 *  position, when set, must be unique within the piece (enforced by the UI). */
export interface Seat {
  instrumentId?: string
  section?: number
  position?: number
}

export interface Piece {
  id: string
  name: string
  playerIds: string[]
  /** Optional pastel colour (hex) for colour-coding this piece in the UI. */
  color?: string
  /** Per-player seating for this piece (instrument/section/position), keyed by player id. */
  seats?: Record<string, Seat>
}

export const INSTRUMENTS_SET_ID = 'instruments'

const DEFAULT_INSTRUMENTS: [string, string][] = [
  ['vl', 'violin'],
  ['vla', 'viola'],
  ['c', 'chello'],
  ['db', 'double bass'],
  ['h', 'harp'],
  ['hsch', 'harpsichord'],
  ['ob', 'oboe'],
  ['fl', 'flute'],
  ['cl', 'clarinet'],
]

export function defaultSets(): ConfigSet[] {
  return [
    {
      id: INSTRUMENTS_SET_ID,
      name: 'Instruments',
      items: DEFAULT_INSTRUMENTS.map(([code, label]) => ({ id: code, code, label })),
    },
  ]
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
  sets: ConfigSet[]
  /** Pastel colour per number (key = the number as string), used to colour-code
   *  Section and Position values for users who associate numbers with colours. */
  numberColors: Record<string, string>
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
    sets: defaultSets(),
    numberColors: {},
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
  const sets: ConfigSet[] = Array.isArray(d.sets)
    ? (d.sets as unknown[])
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map((s) => ({
          id: String(s.id ?? newId()),
          name: String(s.name ?? ''),
          items: Array.isArray(s.items)
            ? (s.items as unknown[])
                .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
                .map((it) => ({ id: String(it.id ?? newId()), code: String(it.code ?? ''), label: String(it.label ?? '') }))
            : [],
        }))
    : defaultSets() // older project files predate sets
  const pieces: Piece[] = (d.pieces as unknown[])
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => {
      const playerIds = Array.isArray(p.playerIds) ? p.playerIds.map(String).filter((id) => playerIdSet.has(id)) : []
      const seats: Record<string, Seat> = {}
      if (typeof p.seats === 'object' && p.seats !== null) {
        for (const [playerId, raw] of Object.entries(p.seats as Record<string, unknown>)) {
          if (!playerIds.includes(playerId) || typeof raw !== 'object' || raw === null) continue
          const r = raw as Record<string, unknown>
          const seat: Seat = {}
          if (typeof r.instrumentId === 'string') seat.instrumentId = r.instrumentId
          if (typeof r.section === 'number' && Number.isFinite(r.section)) seat.section = r.section
          if (typeof r.position === 'number' && Number.isFinite(r.position)) seat.position = r.position
          if (Object.keys(seat).length > 0) seats[playerId] = seat
        }
      }
      return {
        id: String(p.id ?? newId()),
        name: String(p.name ?? ''),
        playerIds,
        ...(typeof p.color === 'string' ? { color: p.color } : {}),
        ...(Object.keys(seats).length > 0 ? { seats } : {}),
      }
    })
  const numberColors: Record<string, string> = {}
  if (typeof d.numberColors === 'object' && d.numberColors !== null) {
    for (const [k, v] of Object.entries(d.numberColors as Record<string, unknown>)) {
      if (/^\d+$/.test(k) && typeof v === 'string') numberColors[k] = v
    }
  }
  return { formatVersion: 1, name: d.name, settings, players, pieces, sets, numberColors }
}

import * as XLSX from 'xlsx'
import type { Combination } from './combinations'
import type { DayPlan } from './dayplan'
import { INSTRUMENTS_SET_ID, type Piece, type Project } from './types'

export interface CombinationPlan {
  combination: Combination
  /** pieceId → venue number (1-based). */
  venueOf: Record<string, number>
  /** playerId → activity text for idle players (self study, coaching, …). */
  activities: Record<string, string>
}

/**
 * Export one reviewed combination as a session plan:
 * venue by venue each piece with its players and their
 * instrument/section/position, followed by the idle players
 * with their assigned activity.
 */
function seatSorter(project: Project) {
  const playerName = new Map(project.players.map((p) => [p.id, p.name]))
  const instruments = project.sets.find((s) => s.id === INSTRUMENTS_SET_ID)?.items ?? []
  const instrumentOrder = new Map(instruments.map((it, i) => [it.id, i]))
  return (piece: Piece) =>
    [...piece.playerIds].sort((a, b) => {
      const sa = piece.seats?.[a] ?? {}
      const sb = piece.seats?.[b] ?? {}
      return (
        (instrumentOrder.get(sa.instrumentId ?? '') ?? 99) - (instrumentOrder.get(sb.instrumentId ?? '') ?? 99) ||
        (sa.section ?? 999) - (sb.section ?? 999) ||
        (sa.position ?? 999) - (sb.position ?? 999) ||
        (playerName.get(a) ?? '').localeCompare(playerName.get(b) ?? '')
      )
    })
}

export interface DayPlanExtras {
  /** session index → pieceId → venue number, from the day-plan review page. */
  venueBySession?: Record<number, Record<string, number>>
  /** session index → playerId → activity text for idle players. */
  activities?: Record<number, Record<string, string>>
}

/** Export a whole-day plan: every session with its venues, players, seats
 *  and the idle players with their activities. */
export function exportDayPlan(project: Project, plan: DayPlan, morningSessions: number, extras: DayPlanExtras = {}): void {
  const playerName = new Map(project.players.map((p) => [p.id, p.name]))
  const instruments = project.sets.find((s) => s.id === INSTRUMENTS_SET_ID)?.items ?? []
  const instrumentCode = new Map(instruments.map((it) => [it.id, it.code]))
  const sortPlayers = seatSorter(project)

  const rows: (string | number)[][] = []
  rows.push([`Day plan — ${project.name}`, '', '', '', '', '', '', ''])
  rows.push([`${plan.sessions.length} sessions × ${project.settings.venues} venues · 1 session = ${project.settings.sessionMinutes} min (incl. break)`, '', '', '', '', '', '', ''])
  rows.push([])
  rows.push(['Session', 'Venue', 'Piece', 'Player', 'Instrument', 'Section', 'Position', 'Activity'])

  plan.sessions.forEach((session, si) => {
    const label = `Session ${si + 1} (${si < morningSessions ? 'morning' : 'afternoon'})`
    const venueOf = extras.venueBySession?.[si] ?? Object.fromEntries(session.pieceIds.map((id, j) => [id, j + 1]))
    const orderedPieceIds = [...session.pieceIds].sort((a, b) => (venueOf[a] ?? 0) - (venueOf[b] ?? 0))
    let sessionCellUsed = false
    orderedPieceIds.forEach((pieceId) => {
      const piece = project.pieces.find((pc) => pc.id === pieceId)
      if (!piece) return
      const venue = venueOf[pieceId] ?? ''
      const players = sortPlayers(piece)
      if (players.length === 0) {
        rows.push([sessionCellUsed ? '' : label, venue, piece.name, '', '', '', '', ''])
        sessionCellUsed = true
        return
      }
      players.forEach((playerId, pi) => {
        const seat = piece.seats?.[playerId] ?? {}
        rows.push([
          sessionCellUsed ? '' : label,
          pi === 0 ? venue : '',
          pi === 0 ? piece.name : '',
          playerName.get(playerId) ?? '?',
          seat.instrumentId ? (instrumentCode.get(seat.instrumentId) ?? '?') : '',
          seat.section ?? '',
          seat.position ?? '',
          '',
        ])
        sessionCellUsed = true
      })
    })
    if (session.pieceIds.length === 0) {
      rows.push([label, '', '— free —', '', '', '', '', ''])
    }
    session.idlePlayerIds.forEach((playerId) => {
      rows.push([
        '', '', 'Idle',
        playerName.get(playerId) ?? '?',
        '', '', '',
        extras.activities?.[si]?.[playerId] ?? '',
      ])
    })
    rows.push([])
  })

  if (plan.unplacedPieceIds.length > 0) {
    rows.push([
      'Unplaced pieces', '',
      plan.unplacedPieceIds.map((id) => project.pieces.find((pc) => pc.id === id)?.name ?? '?').join(', '),
      '', '', '', '', '',
    ])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 20 }, { wch: 7 }, { wch: 24 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 28 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Day plan')
  const safe = project.name.replace(/[^\w\- ]+/g, '_').trim() || 'project'
  XLSX.writeFile(wb, `${safe}-day-plan.xlsx`)
}

export function exportCombinationPlan(project: Project, plan: CombinationPlan): void {
  const playerName = new Map(project.players.map((p) => [p.id, p.name]))
  const instruments = project.sets.find((s) => s.id === INSTRUMENTS_SET_ID)?.items ?? []
  const instrumentCode = new Map(instruments.map((it) => [it.id, it.code]))
  const sortPlayers = seatSorter(project)

  const rows: (string | number)[][] = []
  rows.push([`Session plan — ${project.name}`, '', '', '', '', ''])
  rows.push([`1 session = ${project.settings.sessionMinutes} min (incl. break)`, '', '', '', '', ''])
  rows.push([])
  rows.push(['Venue', 'Piece', 'Player', 'Instrument', 'Section', 'Position'])

  const pieces = plan.combination.pieceIds
    .map((id) => project.pieces.find((pc) => pc.id === id))
    .filter((pc) => pc !== undefined)
    .sort((a, b) => (plan.venueOf[a.id] ?? 0) - (plan.venueOf[b.id] ?? 0))

  for (const piece of pieces) {
    const sortedPlayers = sortPlayers(piece)
    sortedPlayers.forEach((playerId, i) => {
      const seat = piece.seats?.[playerId] ?? {}
      rows.push([
        i === 0 ? (plan.venueOf[piece.id] ?? '') : '',
        i === 0 ? piece.name : '',
        playerName.get(playerId) ?? '?',
        seat.instrumentId ? (instrumentCode.get(seat.instrumentId) ?? '?') : '',
        seat.section ?? '',
        seat.position ?? '',
      ])
    })
    if (sortedPlayers.length === 0) rows.push([plan.venueOf[piece.id] ?? '', piece.name, '', '', '', ''])
  }

  rows.push([])
  rows.push(['Idle players', '', '', 'Activity', '', ''])
  for (const playerId of plan.combination.idlePlayerIds) {
    rows.push(['', '', playerName.get(playerId) ?? '?', plan.activities[playerId] ?? '', '', ''])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 8 }, { wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 8 }, { wch: 8 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Session plan')

  const safe = project.name.replace(/[^\w\- ]+/g, '_').trim() || 'project'
  XLSX.writeFile(wb, `${safe}-session-plan.xlsx`)
}

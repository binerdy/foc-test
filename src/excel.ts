import * as XLSX from 'xlsx'
import type { Combination } from './combinations'
import { INSTRUMENTS_SET_ID, type Piece, type Project } from './types'

/**
 * Export the selected combinations as an .xlsx workbook:
 *  - "Overview": one row per combination (pieces per venue, utilised / idle players)
 *  - "Details": for each combination, each piece with its full player list
 *  - "Assignments": the piece x player matrix of the project
 */
export function exportCombinations(project: Project, selected: Combination[]): void {
  const playerName = new Map(project.players.map((p) => [p.id, p.name]))
  const pieceName = new Map(project.pieces.map((p) => [p.id, p.name]))
  const venues = project.settings.venues
  const instrumentCode = new Map(
    (project.sets.find((s) => s.id === INSTRUMENTS_SET_ID)?.items ?? []).map((it) => [it.id, it.code]),
  )

  // "Anna (vl 1.2)" — instrument code plus section.position, with s/p prefixes when only one is set
  const seatSuffix = (piece: Piece, playerId: string): string => {
    const seat = piece.seats?.[playerId]
    if (!seat) return ''
    const parts: string[] = []
    const code = seat.instrumentId ? instrumentCode.get(seat.instrumentId) : undefined
    if (code) parts.push(code)
    if (seat.section !== undefined && seat.position !== undefined) parts.push(`${seat.section}.${seat.position}`)
    else if (seat.section !== undefined) parts.push(`s${seat.section}`)
    else if (seat.position !== undefined) parts.push(`p${seat.position}`)
    return parts.length > 0 ? ` (${parts.join(' ')})` : ''
  }

  const overviewRows: (string | number)[][] = []
  const header = ['#', ...Array.from({ length: venues }, (_, i) => `Venue ${i + 1}`), 'Players used', 'Players idle', 'Idle players']
  overviewRows.push(header)
  selected.forEach((c, i) => {
    const row: (string | number)[] = [i + 1]
    for (let v = 0; v < venues; v++) row.push(c.pieceIds[v] ? (pieceName.get(c.pieceIds[v]) ?? '?') : '')
    row.push(c.playerIds.length)
    row.push(c.idlePlayerIds.length)
    row.push(c.idlePlayerIds.map((id) => playerName.get(id) ?? '?').join(', '))
    overviewRows.push(row)
  })

  const detailRows: (string | number)[][] = [['#', 'Piece', 'Players']]
  selected.forEach((c, i) => {
    c.pieceIds.forEach((pieceId, j) => {
      const piece = project.pieces.find((p) => p.id === pieceId)
      detailRows.push([
        j === 0 ? i + 1 : '',
        pieceName.get(pieceId) ?? '?',
        piece
          ? piece.playerIds.map((id) => (playerName.get(id) ?? '?') + seatSuffix(piece, id)).join(', ')
          : '',
      ])
    })
    detailRows.push(['', 'Idle', c.idlePlayerIds.map((id) => playerName.get(id) ?? '?').join(', ')])
    detailRows.push([])
  })

  const matrixRows: (string | number)[][] = [
    ['Player \\ Piece', ...project.pieces.map((p) => p.name)],
    ...project.players.map((pl) => [
      pl.name,
      ...project.pieces.map((pc) => (pc.playerIds.includes(pl.id) ? 'X' : '')),
    ]),
  ]

  const wb = XLSX.utils.book_new()
  const wsOverview = XLSX.utils.aoa_to_sheet(overviewRows)
  wsOverview['!cols'] = header.map((h, i) => ({ wch: i === 0 ? 4 : Math.max(14, String(h).length + 2) }))
  XLSX.utils.book_append_sheet(wb, wsOverview, 'Overview')
  const wsDetails = XLSX.utils.aoa_to_sheet(detailRows)
  wsDetails['!cols'] = [{ wch: 4 }, { wch: 24 }, { wch: 60 }]
  XLSX.utils.book_append_sheet(wb, wsDetails, 'Details')
  const wsMatrix = XLSX.utils.aoa_to_sheet(matrixRows)
  wsMatrix['!cols'] = [{ wch: 18 }, ...project.pieces.map((p) => ({ wch: Math.max(6, p.name.length + 2) }))]
  XLSX.utils.book_append_sheet(wb, wsMatrix, 'Assignments')

  const safe = project.name.replace(/[^\w\- ]+/g, '_').trim() || 'project'
  XLSX.writeFile(wb, `${safe}-combinations.xlsx`)
}

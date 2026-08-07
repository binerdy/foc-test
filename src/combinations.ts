import type { Piece, Player } from './types'

export interface Combination {
  /** Pieces rehearsing concurrently, one per venue. */
  pieceIds: string[]
  /** Distinct players utilised by this combination. */
  playerIds: string[]
  /** Players of the project not utilised by this combination. */
  idlePlayerIds: string[]
  /** True if no further selected piece could be added without a conflict or exceeding the venue limit. */
  maximal: boolean
}

export interface CombinationResult {
  combinations: Combination[]
  truncated: boolean
}

/** Hard cap so a huge selection cannot freeze the browser tab. */
export const MAX_COMBINATIONS = 50_000

/**
 * Enumerate every set of 1..venues pieces (from the selected pieces) that can
 * rehearse concurrently without sharing a player, ordered by the number of
 * players utilised (descending) so the top entries keep the fewest players idle.
 */
export function findCombinations(
  selectedPieces: Piece[],
  allPlayers: Player[],
  venues: number,
): CombinationResult {
  const n = selectedPieces.length
  const playerSets = selectedPieces.map((p) => new Set(p.playerIds))

  // Pairwise conflict matrix: pieces conflict when they share at least one player.
  const conflicts: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let shared = false
      for (const id of playerSets[i]) {
        if (playerSets[j].has(id)) { shared = true; break }
      }
      conflicts[i][j] = conflicts[j][i] = shared
    }
  }

  const combos: Combination[] = []
  let truncated = false
  const current: number[] = []

  const emit = () => {
    const used = new Set<string>()
    for (const idx of current) for (const id of playerSets[idx]) used.add(id)
    // Maximal = no piece outside the set is compatible with every piece in it
    // (only meaningful when a venue is still free).
    let maximal = true
    if (current.length < venues) {
      for (let k = 0; k < n; k++) {
        if (current.includes(k)) continue
        if (current.every((idx) => !conflicts[idx][k])) { maximal = false; break }
      }
    }
    combos.push({
      pieceIds: current.map((idx) => selectedPieces[idx].id),
      playerIds: [...used],
      idlePlayerIds: allPlayers.filter((p) => !used.has(p.id)).map((p) => p.id),
      maximal,
    })
  }

  const recurse = (start: number) => {
    if (combos.length >= MAX_COMBINATIONS) { truncated = true; return }
    if (current.length > 0) emit()
    if (current.length >= venues) return
    for (let k = start; k < n; k++) {
      if (current.some((idx) => conflicts[idx][k])) continue
      current.push(k)
      recurse(k + 1)
      current.pop()
      if (truncated) return
    }
  }
  recurse(0)

  combos.sort(
    (a, b) =>
      b.playerIds.length - a.playerIds.length ||
      b.pieceIds.length - a.pieceIds.length ||
      Number(b.maximal) - Number(a.maximal),
  )
  return { combinations: combos, truncated }
}

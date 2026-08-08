import type { Piece, Player } from './types'

export interface SessionPlan {
  pieceIds: string[]
  playerIds: string[]
  idlePlayerIds: string[]
}

export interface DayPlan {
  sessions: SessionPlan[]
  /** Pieces that could not be placed (capacity or conflicts). */
  unplacedPieceIds: string[]
  complete: boolean
}

/** Players appearing in more pieces than the day has sessions — those pieces
 *  can never all be placed, however the plan is arranged. */
export function overbookedPlayers(
  selectedPieces: Piece[],
  sessionCount: number,
): { playerId: string; count: number }[] {
  const per = new Map<string, number>()
  for (const p of selectedPieces) for (const id of p.playerIds) per.set(id, (per.get(id) ?? 0) + 1)
  return [...per.entries()]
    .filter(([, count]) => count > sessionCount)
    .map(([playerId, count]) => ({ playerId, count }))
    .sort((a, b) => b.count - a.count)
}

/** Deterministic PRNG (mulberry32) so "try another arrangement" is reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0 || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Partition the selected pieces over the day's sessions so that every session
 * is conflict-free (no player in two pieces at once) and holds at most
 * `venues` pieces. Each piece is rehearsed once.
 *
 * Objective: pack pieces into as FEW sessions as possible — venues exist so
 * that conflict-free pieces rehearse concurrently, so three conflict-free
 * pieces belong in one session across three venues, not in three sessions.
 *
 * Exact backtracking with most-constrained-first ordering, fullest-session-
 * first choice and empty-session symmetry breaking, bounded by a node budget;
 * if the budget is exhausted or no full assignment exists, a greedy
 * best-effort pass places as many pieces as possible and reports the rest as
 * unplaced. A consolidation pass then merges small sessions into fuller ones
 * where conflicts allow, and used sessions are moved to the front of the day.
 */
export function planDay(
  selectedPieces: Piece[],
  allPlayers: Player[],
  venues: number,
  sessionCount: number,
  seed = 1,
): DayPlan {
  const n = selectedPieces.length
  const rand = makeRng(seed)
  const playerSets = selectedPieces.map((p) => new Set(p.playerIds))

  const conflicts: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const degree = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let shared = false
      for (const id of playerSets[i]) {
        if (playerSets[j].has(id)) { shared = true; break }
      }
      if (shared) {
        conflicts[i][j] = conflicts[j][i] = true
        degree[i]++
        degree[j]++
      }
    }
  }

  // Most-constrained pieces first; seeded jitter varies equivalent orderings
  // between "try another arrangement" runs.
  const jitter = Array.from({ length: n }, () => rand())
  const order = [...Array(n).keys()].sort(
    (a, b) => degree[b] - degree[a] || playerSets[b].size - playerSets[a].size || jitter[a] - jitter[b],
  )
  const sessionJitter = Array.from({ length: sessionCount }, () => rand())

  const sessions: number[][] = Array.from({ length: sessionCount }, () => [])
  const sessionPlayers: Set<string>[] = Array.from({ length: sessionCount }, () => new Set())

  const fits = (piece: number, s: number): boolean => {
    if (sessions[s].length >= venues) return false
    for (const id of playerSets[piece]) if (sessionPlayers[s].has(id)) return false
    return true
  }
  const put = (piece: number, s: number) => {
    sessions[s].push(piece)
    for (const id of playerSets[piece]) sessionPlayers[s].add(id)
  }
  const take = (piece: number, s: number) => {
    sessions[s].pop()
    for (const id of playerSets[piece]) sessionPlayers[s].delete(id)
  }

  const NODE_LIMIT = 300_000
  let nodes = 0
  let aborted = false

  const search = (i: number): boolean => {
    if (i === n) return true
    if (++nodes > NODE_LIMIT) { aborted = true; return false }
    const piece = order[i]
    // Fullest sessions first (pack the day tight) and at most one empty
    // session considered — empty sessions are interchangeable.
    let seenEmpty = false
    const candidates: number[] = []
    for (let s = 0; s < sessionCount; s++) {
      if (sessions[s].length === 0) {
        if (seenEmpty) continue
        seenEmpty = true
      }
      if (fits(piece, s)) candidates.push(s)
    }
    candidates.sort((a, b) => sessions[b].length - sessions[a].length || sessionJitter[a] - sessionJitter[b])
    for (const s of candidates) {
      put(piece, s)
      if (search(i + 1)) return true
      take(piece, s)
      if (aborted) return false
    }
    return false
  }

  const unplaced: number[] = []
  if (!search(0)) {
    for (const s of sessions) s.length = 0
    for (const ps of sessionPlayers) ps.clear()
    for (const piece of order) {
      let target = -1
      for (let s = 0; s < sessionCount; s++) {
        if (fits(piece, s) && (target === -1 || sessions[s].length > sessions[target].length)) target = s
      }
      if (target >= 0) put(piece, target)
      else unplaced.push(piece)
    }
  }

  // Consolidation pass: move pieces from smaller into equal-or-fuller
  // sessions where they fit, emptying sessions and packing the day tighter.
  // (Sum of squared session sizes strictly increases → terminates.)
  let movedSomething = true
  while (movedSomething) {
    movedSomething = false
    for (let from = 0; from < sessionCount; from++) {
      for (const piece of [...sessions[from]]) {
        for (let to = 0; to < sessionCount; to++) {
          if (to === from || sessions[to].length === 0) continue
          if (sessions[to].length < sessions[from].length) continue
          if (!fits(piece, to)) continue
          sessions[from].splice(sessions[from].indexOf(piece), 1)
          for (const id of playerSets[piece]) sessionPlayers[from].delete(id)
          put(piece, to)
          movedSomething = true
          break
        }
      }
    }
  }

  // Used sessions first: the rehearsal day starts with full sessions and the
  // free slots gather at the end.
  const bySize = [...sessions.keys()].sort((a, b) => Number(sessions[a].length === 0) - Number(sessions[b].length === 0))
  const orderedSessions = bySize.map((s) => sessions[s])

  const sessionPlans: SessionPlan[] = orderedSessions.map((idxs) => {
    const used = new Set<string>()
    for (const idx of idxs) for (const id of playerSets[idx]) used.add(id)
    return {
      pieceIds: idxs.map((idx) => selectedPieces[idx].id),
      playerIds: [...used],
      idlePlayerIds: allPlayers.filter((p) => !used.has(p.id)).map((p) => p.id),
    }
  })

  return {
    sessions: sessionPlans,
    unplacedPieceIds: unplaced.map((idx) => selectedPieces[idx].id),
    complete: unplaced.length === 0,
  }
}

export interface FuzzyResult {
  score: number
  indices: number[]
}

/**
 * Fuzzy-match `query` against `candidate` using subsequence matching with scoring.
 * Returns null if no match, or { score, indices } for ranking and highlighting.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, indices: [] }

  const queryLower = query.toLowerCase()
  const candidateLower = candidate.toLowerCase()

  // Quick reject: every query char must exist somewhere
  let checkIdx = 0
  for (let i = 0; i < queryLower.length; i++) {
    const found = candidateLower.indexOf(queryLower[i], checkIdx)
    if (found === -1) return null
    checkIdx = found + 1
  }

  // Score the match
  const indices: number[] = []
  let score = 0
  let candidateIdx = 0
  let prevMatchIdx = -2 // -2 so first match isn't "consecutive"

  for (let qi = 0; qi < queryLower.length; qi++) {
    const qChar = queryLower[qi]
    let bestIdx = -1
    let bestScore = -Infinity

    // Look for the best position for this query char
    for (let ci = candidateIdx; ci < candidateLower.length; ci++) {
      if (candidateLower[ci] !== qChar) continue

      let posScore = 0

      // Consecutive match bonus
      if (ci === prevMatchIdx + 1) posScore += 8

      // Word boundary bonus (after /, -, _, . or camelCase)
      if (ci === 0) {
        posScore += 6
      } else {
        const prev = candidate[ci - 1]
        if (prev === '/' || prev === '-' || prev === '_' || prev === '.') {
          posScore += 5
        } else if (
          candidate[ci] === candidate[ci].toUpperCase() &&
          candidate[ci - 1] === candidate[ci - 1].toLowerCase()
        ) {
          posScore += 4 // camelCase boundary
        }
      }

      // Exact case bonus
      if (candidate[ci] === query[qi]) posScore += 1

      // Prefer earlier matches (small penalty for distance)
      posScore -= ci * 0.01

      if (posScore > bestScore) {
        bestScore = posScore
        bestIdx = ci
      }

      // If we got a consecutive or boundary match, don't look further
      if (posScore >= 5) break
    }

    if (bestIdx === -1) return null // shouldn't happen after quick reject

    indices.push(bestIdx)
    score += bestScore
    prevMatchIdx = bestIdx
    candidateIdx = bestIdx + 1
  }

  // Length penalty — prefer shorter paths
  score -= candidate.length * 0.005

  // Bonus for query matching a higher proportion of the candidate
  score += (query.length / candidate.length) * 3

  return { score, indices }
}

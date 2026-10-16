// Fuzzy matching of a query against paths, for quick open: every letter
// of the query in order, scored by clusters of consecutive letters, with a
// bonus for a cluster at the start or after a separator, and shorter paths
// first on ties. Case does not matter.

export interface PathMatch {
  path: string;
  score: number;
  // Where the query's letters are in the path, for marking them.
  positions: number[];
}

// The best `limit` matches for `query`, best first.
export function matchingPaths(query: string, paths: string[], limit = 50): PathMatch[] {
  const matches: PathMatch[] = [];
  for (const path of paths) {
    const match = fuzzyPathMatch(query, path);
    if (match) matches.push(match);
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, limit);
}

// The greedy scan alone finds "end" in "lib/med/endpoint.ex" as
// "lib/m[e]d/e[n][d]point.ex" and misses the "en" cluster. So at each
// letter found it looks back for the longest cluster ending there, and
// scores (and places) the cluster's letters by it, where that beats what
// they had: each letter of the query counts once.
export function fuzzyPathMatch(query: string, target: string): PathMatch | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const scores = new Array<number>(q.length).fill(0);
  const positions = new Array<number>(q.length).fill(0);
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let run = 1;
    while (ti - run >= 0 && qi - run >= 0 && q[qi - run] === t[ti - run]) run++;
    const start = ti - run + 1;
    let score = 1 + run * 0.5;
    if (start === 0 || '/_.-'.includes(t[start - 1])) score += 5;
    for (let i = qi - run + 1; i <= qi; i++) {
      if (score > scores[i]) {
        scores[i] = score;
        positions[i] = start + i - (qi - run + 1);
      }
    }
    qi++;
  }
  if (qi !== q.length) return null;
  const total = scores.reduce((sum, score) => sum + score, 0);
  return { path: target, score: total + 1 / (t.length + 1), positions };
}

// Pure puzzle logic for Glint: grid, beam tracing, generation and solving.
// No rendering imports, so it can run in Node for verification.

export type Dir = 0 | 1 | 2 | 3; // +x, +y, -x, -y
export const DX = [1, 0, -1, 0];
export const DY = [0, 1, 0, -1];

export type Piece =
  | { kind: 'emitter'; x: number; y: number; dir: Dir; color: number }
  | { kind: 'mirror'; x: number; y: number; slash: boolean; locked: boolean }
  | { kind: 'splitter'; x: number; y: number; slash: boolean; locked: boolean }
  | { kind: 'wall'; x: number; y: number }
  | { kind: 'target'; x: number; y: number; color: number };

export type Turnable = Extract<Piece, { kind: 'mirror' | 'splitter' }>;

export interface Level {
  size: number;
  pieces: Piece[];
  par: number;
  seed: number;
}

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: number;
}

export interface TraceResult {
  segments: Segment[];
  lit: boolean[]; // per target, in piece order
  solved: boolean;
}

// '/' joins bottom-left to top-right: +x <-> +y, -x <-> -y
const SLASH: Dir[] = [1, 0, 3, 2];
// '\' joins top-left to bottom-right: +x <-> -y, -x <-> +y
const BACK: Dir[] = [3, 2, 1, 0];

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function trace(level: Level): TraceResult {
  const n = level.size;
  const grid: (Piece | undefined)[] = new Array(n * n);
  const targets: Piece[] = [];
  for (const p of level.pieces) {
    grid[p.y * n + p.x] = p;
    if (p.kind === 'target') targets.push(p);
  }
  const lit = targets.map(() => false);
  const segments: Segment[] = [];

  for (const e of level.pieces) {
    if (e.kind !== 'emitter') continue;
    const seen = new Set<number>();
    const stack: { x: number; y: number; dir: Dir }[] = [
      { x: e.x, y: e.y, dir: e.dir },
    ];
    while (stack.length) {
      const beam = stack.pop()!;
      let { x, y, dir } = beam;
      let sx = x;
      let sy = y;
      for (;;) {
        const nx = x + DX[dir];
        const ny = y + DY[dir];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) {
          // run off the board: draw to the edge
          segments.push({
            x0: sx,
            y0: sy,
            x1: x + DX[dir] * 0.5,
            y1: y + DY[dir] * 0.5,
            color: e.color,
          });
          break;
        }
        x = nx;
        y = ny;
        const key = (y * n + x) * 4 + dir;
        if (seen.has(key)) {
          segments.push({ x0: sx, y0: sy, x1: x, y1: y, color: e.color });
          break;
        }
        seen.add(key);
        const p = grid[y * n + x];
        if (!p) continue;
        if (p.kind === 'target') {
          if (p.color === e.color) lit[targets.indexOf(p)] = true;
          continue; // crystals let light through
        }
        segments.push({ x0: sx, y0: sy, x1: x, y1: y, color: e.color });
        if (p.kind === 'wall' || p.kind === 'emitter') break;
        const out = (p.slash ? SLASH : BACK)[dir];
        if (p.kind === 'splitter') stack.push({ x, y, dir });
        dir = out;
        sx = x;
        sy = y;
      }
    }
  }
  return { segments, lit, solved: lit.length > 0 && lit.every(Boolean) };
}

export function turnables(level: Level): Turnable[] {
  return level.pieces.filter(
    (p): p is Turnable =>
      (p.kind === 'mirror' || p.kind === 'splitter') && !p.locked,
  );
}

/** Brute-force every mirror state. Returns fewest taps to solve and how many states solve it. */
export function solve(level: Level): {
  best: number;
  solutions: number;
  states: number;
  bestMask: number;
} {
  const t = turnables(level);
  const start = t.map((p) => p.slash);
  const states = 1 << t.length;
  let best = Infinity;
  let bestMask = 0;
  let solutions = 0;
  for (let mask = 0; mask < states; mask++) {
    let taps = 0;
    for (let i = 0; i < t.length; i++) {
      const flip = (mask >> i) & 1;
      t[i].slash = flip ? !start[i] : start[i];
      taps += flip;
    }
    if (trace(level).solved) {
      solutions++;
      if (taps < best) {
        best = taps;
        bestMask = mask;
      }
    }
  }
  t.forEach((p, i) => (p.slash = start[i]));
  return { best, solutions, states, bestMask };
}

/** The next mirror worth tapping on the shortest path to a solution, or undefined when solved. */
export function hint(level: Level): Turnable | undefined {
  const { bestMask, best } = solve(level);
  if (!isFinite(best) || best === 0) return undefined;
  const t = turnables(level);
  for (let i = 0; i < t.length; i++) if ((bestMask >> i) & 1) return t[i];
  return undefined;
}

export interface Recipe {
  size: number;
  emitters: number;
  mirrors: number;
  splitters: number;
  walls: number;
  targets: number;
  minPar: number;
  locked?: number;
}

export function generate(seed: number, r: Recipe): Level {
  for (let attempt = 0; attempt < 4000; attempt++) {
    const level = tryGenerate(seed * 7919 + attempt * 104729, r);
    if (level) {
      level.seed = seed;
      return level;
    }
  }
  // Extremely unlikely; relax the recipe rather than fail.
  return generate(seed + 1, { ...r, minPar: Math.max(1, r.minPar - 1) });
}

function tryGenerate(seed: number, r: Recipe): Level | undefined {
  const rnd = mulberry32(seed);
  const n = r.size;
  const used = new Set<number>();
  const pieces: Piece[] = [];
  const free = (): { x: number; y: number } | undefined => {
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(rnd() * n);
      const y = Math.floor(rnd() * n);
      if (!used.has(y * n + x)) {
        used.add(y * n + x);
        return { x, y };
      }
    }
    return undefined;
  };

  // Emitters sit on an edge and fire inward.
  for (let i = 0; i < r.emitters; i++) {
    let placed = false;
    for (let k = 0; k < 40 && !placed; k++) {
      const side = Math.floor(rnd() * 4) as Dir;
      const along = Math.floor(rnd() * n);
      const x = side === 0 ? 0 : side === 2 ? n - 1 : along;
      const y = side === 1 ? 0 : side === 3 ? n - 1 : along;
      if (used.has(y * n + x)) continue;
      used.add(y * n + x);
      pieces.push({ kind: 'emitter', x, y, dir: side, color: i });
      placed = true;
    }
    if (!placed) return undefined;
  }
  for (let i = 0; i < r.mirrors; i++) {
    const c = free();
    if (!c) return undefined;
    pieces.push({ kind: 'mirror', ...c, slash: rnd() < 0.5, locked: false });
  }
  for (let i = 0; i < r.splitters; i++) {
    const c = free();
    if (!c) return undefined;
    pieces.push({ kind: 'splitter', ...c, slash: rnd() < 0.5, locked: false });
  }
  for (let i = 0; i < r.walls; i++) {
    const c = free();
    if (!c) return undefined;
    pieces.push({ kind: 'wall', ...c });
  }

  // Trace the solved arrangement and drop crystals onto lit, empty cells
  // that the light only reaches after at least one bounce.
  const level: Level = { size: n, pieces, par: 0, seed };
  const candidates: { x: number; y: number; color: number; depth: number }[] =
    [];
  for (const e of pieces) {
    if (e.kind !== 'emitter') continue;
    const solo: Level = {
      size: n,
      pieces: pieces.filter((p) => p.kind !== 'emitter' || p === e),
      par: 0,
      seed,
    };
    const segs = trace(solo).segments;
    segs.forEach((s, depth) => {
      if (depth === 0) return;
      const len = Math.round(Math.abs(s.x1 - s.x0) + Math.abs(s.y1 - s.y0));
      const dx = Math.sign(s.x1 - s.x0);
      const dy = Math.sign(s.y1 - s.y0);
      for (let k = 1; k < len; k++) {
        const x = Math.round(s.x0 + dx * k);
        const y = Math.round(s.y0 + dy * k);
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (!used.has(y * n + x)) candidates.push({ x, y, color: e.color, depth });
      }
    });
  }
  if (candidates.length < r.targets) return undefined;
  // Prefer deep cells, and make sure every colour gets a crystal.
  candidates.sort((a, b) => b.depth - a.depth + (rnd() - 0.5));
  const chosen: typeof candidates = [];
  for (let c = 0; c < r.emitters; c++) {
    const pick = candidates.find(
      (k) => k.color === c && !chosen.some((o) => o.x === k.x && o.y === k.y),
    );
    if (!pick) return undefined;
    chosen.push(pick);
  }
  for (const k of candidates) {
    if (chosen.length >= r.targets) break;
    if (!chosen.some((o) => o.x === k.x && o.y === k.y)) chosen.push(k);
  }
  if (chosen.length < r.targets) return undefined;
  for (const k of chosen) {
    used.add(k.y * n + k.x);
    pieces.push({ kind: 'target', x: k.x, y: k.y, color: k.color });
  }
  if (!trace(level).solved) return undefined;

  // Lock a few mirrors in their solved pose, then scramble the rest.
  const t = turnables(level);
  for (let i = 0; i < (r.locked ?? 0) && i < t.length - r.minPar; i++) {
    t[Math.floor(rnd() * t.length)].locked = true;
  }
  const loose = turnables(level);
  let flips = 0;
  for (const p of loose) {
    if (rnd() < 0.6) {
      p.slash = !p.slash;
      flips++;
    }
  }
  if (flips === 0) return undefined;
  const s = solve(level);
  if (!isFinite(s.best) || s.best < r.minPar) return undefined;
  // Reject boards that are too forgiving (only meaningful once there are enough mirrors).
  if (s.states >= 16 && s.solutions / s.states > 0.26) return undefined;
  level.par = s.best;
  return level;
}

// The campaign: a gentle ramp from one mirror to two colours and splitters.
export const CAMPAIGN: Recipe[] = [
  { size: 4, emitters: 1, mirrors: 1, splitters: 0, walls: 0, targets: 1, minPar: 1 },
  { size: 4, emitters: 1, mirrors: 2, splitters: 0, walls: 0, targets: 1, minPar: 1 },
  { size: 4, emitters: 1, mirrors: 3, splitters: 0, walls: 1, targets: 2, minPar: 2 },
  { size: 5, emitters: 1, mirrors: 4, splitters: 0, walls: 1, targets: 2, minPar: 2 },
  { size: 5, emitters: 1, mirrors: 3, splitters: 1, walls: 1, targets: 2, minPar: 2 },
  { size: 5, emitters: 1, mirrors: 4, splitters: 1, walls: 2, targets: 3, minPar: 3 },
  { size: 5, emitters: 2, mirrors: 4, splitters: 0, walls: 1, targets: 2, minPar: 2 },
  { size: 5, emitters: 2, mirrors: 5, splitters: 0, walls: 2, targets: 3, minPar: 3 },
  { size: 6, emitters: 2, mirrors: 5, splitters: 1, walls: 2, targets: 3, minPar: 3 },
  { size: 6, emitters: 2, mirrors: 6, splitters: 1, walls: 2, targets: 4, minPar: 3, locked: 1 },
  { size: 6, emitters: 2, mirrors: 6, splitters: 2, walls: 3, targets: 4, minPar: 4, locked: 1 },
  { size: 6, emitters: 2, mirrors: 7, splitters: 2, walls: 3, targets: 5, minPar: 4, locked: 2 },
];

const DAILY: Recipe = {
  size: 6, emitters: 2, mirrors: 6, splitters: 2, walls: 3, targets: 4, minPar: 4, locked: 1,
};

export function campaignLevel(index: number): Level {
  return generate(1000 + index * 37, CAMPAIGN[index]);
}

/** Days since the Unix epoch in the player's local time. */
export function dayNumber(now = new Date()): number {
  return Math.floor(
    (now.getTime() - now.getTimezoneOffset() * 60000) / 86400000,
  );
}

export function dailyLevel(day = dayNumber()): Level {
  return generate(500000 + day, DAILY);
}

export function starsFor(taps: number, par: number): number {
  if (taps <= par) return 3;
  if (taps <= par + 2) return 2;
  return 1;
}

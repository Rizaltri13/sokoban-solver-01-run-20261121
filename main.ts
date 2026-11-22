// sokoban-solver: a push-optimal Sokoban solver for make.fun's
// sokoban-solver-01-run-20261121.
//
// A level here is a hallway with independent rooms off it: a box pushed out
// of a room can never be pushed back, so each room is its own puzzle and the
// level's push-optimum is the sum of the rooms'. This program splits the
// level into rooms, solves every room push-optimally with A* over pushes,
// and joins the answers with walks through the hallway.
//
// A search state is the sorted box squares together with the square the
// player stands on; states that share a box layout and a reachable region
// are one state, keyed by the region's lowest square. The estimate is the
// cheapest assignment of boxes to goals under walking distances: one push
// moves one box one square, so the estimate can only drop by one a push,
// which makes it admissible. Dead squares (no pull path back to a goal) and
// frozen 2x2 blocks are pruned. Every budget is a count of expanded states,
// never the clock, so two runs print the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps, in one fixed order so every tie breaks the same way.
const STEP_LETTER = ['u', 'd', 'l', 'r'];
const PUSH_LETTER = ['U', 'D', 'L', 'R'];

// Budgets in expanded states. A room the generator kept is solvable well
// inside ROOM_CAP; TOTAL_CAP bounds the whole set.
const ROOM_CAP = 250_000;
const WHOLE_CAP = 500_000;
const TOTAL_CAP = 2_500_000;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  cells: number[];
  boxes: number[];
  goals: number[];
}

interface SearchResult {
  pushes: number;
  moves: string;
  end: number;
}

interface Budget {
  used: number;
}

/** The board step for direction k on a board w wide. */
const deltaOf = (w: number, k: number): number => (k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1);

/** A level in XSB text: its width and height, walls, goals, boxes, player. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a box can be pulled back from to some goal, ignoring the other
 * boxes: start at the goals and walk pulls backwards. A box off a live square
 * can never reach a goal, so such a state is dead and pruned.
 */
function liveCells(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = deltaOf(b.w, k);
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` around walls and `blocked`
 * (boxes), marked in `seen` under `stamp`; returns the lowest such square,
 * which names the whole region.
 */
function floodRegion(
  b: Board,
  blocked: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + deltaOf(b.w, k);
      if (!b.wall[q] && !blocked[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and
 * boxes with a box off its goal: no push can ever move such a box again.
 */
function frozenBlock(b: Board, blocked: Uint8Array, goalSet: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c1 = a + 1;
    const c2 = a + w;
    const c3 = c2 + 1;
    if (!((b.wall[a] || blocked[a]) && (b.wall[c1] || blocked[c1]) && (b.wall[c2] || blocked[c2]) && (b.wall[c3] || blocked[c3]))) continue;
    if ((blocked[a] && !goalSet[a]) || (blocked[c1] && !goalSet[c1]) || (blocked[c2] && !goalSet[c2]) || (blocked[c3] && !goalSet[c3])) return true;
  }
  return false;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, a goal falls in the cut, or a box starts in the hallway: then the
 * level is no set of rooms.
 */
function splitRooms(level: Board): Room[] | null {
  const live = liveCells(level);
  const row = Math.floor(level.player / level.w);
  const cut = new Uint8Array(level.w * level.h);
  for (let x = 0; x < level.w; x++) {
    const i = row * level.w + x;
    if (!level.wall[i] && !live[i]) cut[i] = 1;
  }
  if (level.boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(level.w * level.h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < level.w * level.h; s++) {
    if (level.wall[s] || cut[s] || part[s] >= 0) continue;
    const cells = [s];
    part[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = cells[i]! + deltaOf(level.w, k);
        if (!level.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ cells, boxes: [], goals: [] });
  }
  for (const b of level.boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of level.goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  withBoxes.sort((a, b) => a.cells[0]! - b.cells[0]!);
  return withBoxes;
}

/**
 * A board for one room alone: every other room's boxes stand as walls (at
 * their current squares), so the room's search never moves them.
 */
function roomBoard(level: Board, room: Room, player: number, currentBoxes: number[]): Board {
  const wall = level.wall.slice();
  for (const b of currentBoxes) {
    if (!room.boxes.includes(b)) wall[b] = 1;
  }
  return {
    w: level.w,
    h: level.h,
    wall,
    goals: room.goals.slice().sort((a, b) => a - b),
    boxes: room.boxes.slice().sort((a, b) => a - b),
    player,
  };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters, or null when unreachable. */
function walkTo(b: Board, boxes: number[], from: number, to: number): string | null {
  if (from === to) return '';
  const blocked = new Uint8Array(b.w * b.h);
  for (const x of boxes) blocked[x] = 1;
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how: string[] = new Array(b.w * b.h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + deltaOf(b.w, k);
      if (b.wall[q] || blocked[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP_LETTER[k]!;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * The push-optimal solution of `board`: A* over pushes. A state is the
 * sorted boxes and the player's square, keyed by the boxes and the lowest
 * square of the player's region. Returns {pushes, moves, end} or null when
 * the search gives up (or the board has no solution).
 */
function searchPushes(board: Board, cap: number, budget: Budget): SearchResult | null {
  const { w, wall } = board;
  const size = w * board.h;
  const n = board.boxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of board.goals) goalSet[g] = 1;
  const live = liveCells(board);
  for (const b of board.boxes) if (!live[b]) return null;

  // Walking distance from each goal over the floor, ignoring boxes.
  const distFrom: Int32Array[] = board.goals.map((g) => {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (let k = 0; k < 4; k++) {
        const nb = p + deltaOf(w, k);
        if (!wall[nb] && dist[nb] < 0) {
          dist[nb] = dist[p]! + 1;
          queue.push(nb);
        }
      }
    }
    return dist;
  });

  // Every order the goals can take the boxes, for the assignment estimate.
  const orders: number[][] = [];
  const buildOrders = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) {
      orders.push(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      buildOrders([...prefix, rest[i]!], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  buildOrders([], board.goals.map((_, i) => i));

  // Cheapest assignment of boxes to goals under walking distances; Infinity
  // when some box reaches no goal. A push moves one box one square, so this
  // can drop by at most one a push: admissible, and consistent.
  const estimate = (boxes: number[]): number => {
    let best = Infinity;
    for (const order of orders) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = distFrom[order[i]!]![boxes[i]!]!;
        if (d < 0) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };

  // A state's key: the boxes (four or fewer pack into one number) and the
  // lowest square of the player's region; more boxes key by their squares.
  const keyOf = (boxes: number[], low: number): number | string => {
    if (n <= 4) {
      let pack = 0;
      for (const b of boxes) pack = pack * 256 + (b + 1);
      return pack * 256 + low;
    }
    return `${boxes.join(',')}/${low}`;
  };

  // The states in the order found: their boxes (flat, n a state), the
  // player's square, the region's lowest square, the parent, the push that
  // made them (box square times four plus direction), and pushes so far.
  const store: number[] = [];
  const at: number[] = [];
  const lowOf: number[] = [];
  const parent: number[] = [-1];
  const pushCode: number[] = [-1];
  const pushesSoFar: number[] = [0];
  const readBoxes = (id: number, out: number[]): number[] => {
    for (let i = 0; i < n; i++) out[i] = store[id * n + i]!;
    return out;
  };

  // The open list: a heap on (estimate + pushes, estimate, insertion order).
  const heapF: number[] = [];
  const heapH: number[] = [];
  const heapId: number[] = [];
  const heapSeq: number[] = [];
  let seq = 0;
  const heapBefore = (i: number, j: number): boolean =>
    heapF[i]! !== heapF[j]!
      ? heapF[i]! < heapF[j]!
      : heapH[i]! !== heapH[j]!
        ? heapH[i]! < heapH[j]!
        : heapSeq[i]! < heapSeq[j]!;
  const heapSwap = (i: number, j: number): void => {
    [heapF[i], heapF[j]] = [heapF[j]!, heapF[i]!];
    [heapH[i], heapH[j]] = [heapH[j]!, heapH[i]!];
    [heapId[i], heapId[j]] = [heapId[j]!, heapId[i]!];
    [heapSeq[i], heapSeq[j]] = [heapSeq[j]!, heapSeq[i]!];
  };
  const heapPush = (f: number, h: number, id: number): void => {
    heapF.push(f);
    heapH.push(h);
    heapId.push(id);
    heapSeq.push(seq++);
    let i = heapF.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapBefore(i, p)) break;
      heapSwap(i, p);
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heapId[0]!;
    const last = heapF.length - 1;
    heapF[0] = heapF[last]!;
    heapH[0] = heapH[last]!;
    heapId[0] = heapId[last]!;
    heapSeq[0] = heapSeq[last]!;
    heapF.pop();
    heapH.pop();
    heapId.pop();
    heapSeq.pop();
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heapF.length) break;
      if (c + 1 < heapF.length && heapBefore(c + 1, c)) c++;
      if (!heapBefore(c, i)) break;
      heapSwap(i, c);
      i = c;
    }
    return top;
  };

  // The search's scratch: two stamp-marked reachability maps and a stack.
  const blocked = new Uint8Array(size);
  const seenA = new Int32Array(size);
  const seenB = new Int32Array(size);
  const stack = new Int32Array(size);
  let stampA = 0;
  let stampB = 0;

  const best = new Map<number | string, number>();
  const startBoxes = board.boxes.slice().sort((a, b) => a - b);
  for (const b of startBoxes) blocked[b] = 1;
  const startLow = floodRegion(board, blocked, board.player, seenA, ++stampA, stack);
  for (const b of startBoxes) blocked[b] = 0;
  for (let i = 0; i < n; i++) store.push(startBoxes[i]!);
  at.push(board.player);
  lowOf.push(startLow);
  const startEst = estimate(startBoxes);
  if (startEst === Infinity) return null;
  best.set(keyOf(startBoxes, startLow), 0);
  heapPush(startEst, startEst, 0);

  // Rebuild the moves of a solved state: walk to each push's square, push.
  const rebuild = (id: number): SearchResult | null => {
    const codes: number[] = [];
    for (let s = id; s > 0; s = parent[s]!) codes.push(pushCode[s]!);
    codes.reverse();
    let moves = '';
    let player = board.player;
    const boxes = board.boxes.slice().sort((a, b) => a - b);
    for (const code of codes) {
      const from = Math.floor(code / 4);
      const k = code % 4;
      const d = deltaOf(w, k);
      const walk = walkTo(board, boxes, player, from - d);
      if (walk === null) return null;
      moves += walk + PUSH_LETTER[k]!;
      player = from;
      boxes[boxes.indexOf(from)] = from + d;
      boxes.sort((a, b) => a - b);
    }
    return { pushes: codes.length, moves, end: player };
  };

  const scratch: number[] = new Array(n);
  let expanded = 0;
  while (heapF.length > 0) {
    const id = heapPop();
    const boxes = readBoxes(id, scratch);
    if (best.get(keyOf(boxes, lowOf[id]!)) !== pushesSoFar[id]) continue;
    if (boxes.every((b) => goalSet[b])) {
      const done = rebuild(id);
      if (done !== null) return done;
      return null;
    }
    expanded++;
    budget.used++;
    if (expanded > cap || budget.used > TOTAL_CAP) return null;
    for (const b of boxes) blocked[b] = 1;
    const stamp = ++stampA;
    floodRegion(board, blocked, at[id]!, seenA, stamp, stack);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = deltaOf(w, k);
        const behind = b - d;
        const target = b + d;
        if (seenA[behind] !== stamp) continue;
        if (wall[target] || blocked[target] || !live[target]) continue;
        const next = boxes.slice();
        next[bi] = target;
        next.sort((a, b2) => a - b2);
        blocked[b] = 0;
        blocked[target] = 1;
        const frozen = frozenBlock(board, blocked, goalSet, target);
        let low2 = -1;
        if (!frozen) low2 = floodRegion(board, blocked, b, seenB, ++stampB, stack);
        blocked[target] = 0;
        blocked[b] = 1;
        if (frozen) continue;
        const g2 = pushesSoFar[id]! + 1;
        const key2 = keyOf(next, low2);
        const prev = best.get(key2);
        if (prev !== undefined && prev <= g2) continue;
        const h2 = estimate(next);
        if (h2 === Infinity) continue;
        best.set(key2, g2);
        const nid = at.length;
        for (let i = 0; i < n; i++) store.push(next[i]!);
        at.push(b);
        lowOf.push(low2);
        parent.push(id);
        pushCode.push(b * 4 + k);
        pushesSoFar.push(g2);
        heapPush(g2 + h2, h2, nid);
      }
    }
    for (const b of boxes) blocked[b] = 0;
  }
  return null;
}

/** The whole level solved as one search, a fallback when it is no set of rooms. */
function solveWhole(level: Board, budget: Budget): string {
  const found = searchPushes(level, WHOLE_CAP, budget);
  return found === null ? '' : found.moves;
}

/** One level's moves: room by room, the player walking on from room to room. */
function solveLevel(text: string, budget: Budget): string {
  const level = parseLevel(text);
  const rooms = splitRooms(level);
  if (rooms === null) return solveWhole(level, budget);
  let player = level.player;
  let moves = '';
  const currentBoxes = level.boxes.slice().sort((a, b) => a - b);
  for (const room of rooms) {
    const sub = roomBoard(level, room, player, currentBoxes);
    const found = searchPushes(sub, ROOM_CAP, budget);
    if (found === null) return solveWhole(level, budget);
    moves += found.moves;
    player = found.end;
    // This room's boxes now stand on its goals; the next room sees them there.
    const rest = currentBoxes.filter((b) => !room.boxes.includes(b));
    currentBoxes.length = 0;
    currentBoxes.push(...rest, ...room.goals);
    currentBoxes.sort((a, b) => a - b);
  }
  return moves;
}

const budget: Budget = { used: 0 };
for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}

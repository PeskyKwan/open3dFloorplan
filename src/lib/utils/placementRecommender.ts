/**
 * placementRecommender — "where does this piece of furniture fit best?"
 *
 * Pure geometry (no Svelte / Three imports) so it can be unit-tested standalone.
 * All coordinates are in the app's world units (cm), matching FurnitureItem.position
 * (bounding-box CENTER) and rotation in DEGREES. At rotation 0, width runs along X
 * and depth along Y (same convention as snapFurnitureToWall in FloorPlanCanvas).
 *
 * The convenience wrapper `recommendPlacementForRoom` builds the inputs from a Floor.
 */
import type { Point, Wall, Room, Door, FurnitureItem } from '$lib/models/types';
import { getRoomPolygon } from '$lib/utils/roomDetection';

/** Axis-aligned rectangle described by its centre + size. */
export interface Rect { cx: number; cy: number; w: number; h: number; }

export interface PlacementItem { width: number; depth: number; }

export type PlacementStrategy = 'wall' | 'center' | 'clearance';

export interface PlacementOptions {
  /** Min gap (cm) to keep from other furniture. Default 8. */
  clearance?: number;
  /** Gap (cm) between the item's back and the wall it sits against. Default 2. */
  wallGap?: number;
  /** Candidate sampling step (cm). Smaller = more precise but slower. Default 15. */
  step?: number;
  /** Rotations (deg) to try for interior/grid candidates. Default [0, 90]. */
  rotations?: number[];
  /** Keep-clear depth (cm) in front of every door. Default 80. */
  doorClearance?: number;
  /** Keep furniture this far inside the wall CENTRELINE polygon (≈ half wall thickness)
   *  so pieces don't poke into walls. The Floor wrappers set this from wall thickness. Default 0. */
  wallInset?: number;
  /** What "best" means. Default 'wall' (push against a wall, stay out of the way). */
  strategy?: PlacementStrategy;
  /** Footprints of furniture that must NOT move — arrange around them. */
  fixedRects?: Rect[];
}

export interface PlacementResult {
  position: Point;   // centre, cm
  rotation: number;  // degrees (0/90/180/270)
  score: number;
  footprint: Rect;
  againstWall: boolean;
}

const DEFAULTS = { clearance: 8, wallGap: 2, step: 15, doorClearance: 80, wallInset: 0 };

// ─────────────────────────── geometry helpers ───────────────────────────

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = (yi > p.y) !== (yj > p.y) &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function corners(r: Rect): Point[] {
  const hw = r.w / 2, hh = r.h / 2;
  return [
    { x: r.cx - hw, y: r.cy - hh },
    { x: r.cx + hw, y: r.cy - hh },
    { x: r.cx + hw, y: r.cy + hh },
    { x: r.cx - hw, y: r.cy + hh },
  ];
}

/** Axis-aligned overlap test (rects expanded by `pad` on all sides). */
function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + pad &&
         Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 + pad;
}

function segIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (b: Point, a: Point) => ({ x: b.x - a.x, y: b.y - a.y });
  const cross = (u: Point, v: Point) => u.x * v.y - u.y * v.x;
  const r = d(p2, p1), s = d(p4, p3);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-9) return false;
  const qp = d(p3, p1);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/** Is the rectangle fully inside the polygon, keeping `margin` cm clear of every edge?
 *  margin ≈ half wall thickness keeps furniture off walls (polygon runs along wall centrelines). */
function rectInsidePolygon(rect: Rect, poly: Point[], margin = 0): boolean {
  const cs = corners(rect);
  for (const c of cs) if (!pointInPolygon(c, poly)) return false;
  // Guard against concave notches poking through an edge between corners.
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i], b = cs[(i + 1) % cs.length];
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      if (segIntersect(a, b, poly[k], poly[j])) return false;
    }
  }
  // Keep every corner at least `margin` inside (off the walls).
  if (margin > 0) {
    for (const c of cs) if (distToPolygonEdges(c, poly) < margin - 0.5) return false;
  }
  return true;
}

/** Min centre-to-centre free gap between two axis-aligned rects (0 if touching/overlapping). */
function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.abs(a.cx - b.cx) - (a.w + b.w) / 2;
  const dy = Math.abs(a.cy - b.cy) - (a.h + b.h) / 2;
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy);
  return Math.max(dx, dy, 0);
}

function dist(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }

/** Distance from point p to segment ab. */
function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shortest distance from p to any edge of the polygon. */
function distToPolygonEdges(p: Point, poly: Point[]): number {
  let m = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    m = Math.min(m, distToSeg(p, poly[j], poly[i]));
  }
  return m;
}

/** Footprint of an item placed at (cx,cy) with the given rotation. */
export function footprintOf(cx: number, cy: number, rotation: number, item: PlacementItem): Rect {
  const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const swap = r === 90 || r === 270;
  return { cx, cy, w: swap ? item.depth : item.width, h: swap ? item.width : item.depth };
}

function bbox(poly: Point[]) {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function polygonCentroid(poly: Point[]): Point {
  return {
    x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
    y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
  };
}

// ─────────────────────────── candidate generation ───────────────────────────

interface Candidate { cx: number; cy: number; rotation: number; againstWall: boolean; }

/** Rotation (deg) whose "back" (−Y at rot 0) points along `dir`. */
function rotationForBackDir(dir: Point): number {
  // back(r): 0->(0,-1) 90->(1,0) 180->(0,1) 270->(-1,0)
  const opts: [number, Point][] = [
    [0, { x: 0, y: -1 }], [90, { x: 1, y: 0 }], [180, { x: 0, y: 1 }], [270, { x: -1, y: 0 }],
  ];
  let best = 0, bestDot = -Infinity;
  for (const [r, b] of opts) {
    const dot = b.x * dir.x + b.y * dir.y;
    if (dot > bestDot) { bestDot = dot; best = r; }
  }
  return best;
}

function wallCandidates(poly: Point[], item: PlacementItem, step: number, wallGap: number, wallInset: number): Candidate[] {
  const out: Candidate[] = [];
  const centroid = polygonCentroid(poly);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1) continue;
    const ux = ex / len, uy = ey / len;              // along edge
    // Inward normal: pick the perpendicular that points toward the centroid.
    let nx = -uy, ny = ux;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((centroid.x - mid.x) * nx + (centroid.y - mid.y) * ny < 0) { nx = -nx; ny = -ny; }
    const backDir = { x: -nx, y: -ny };              // faces the wall
    const rotation = rotationForBackDir(backDir);
    const fp = footprintOf(0, 0, rotation, item);
    // Depth is the footprint size along the inward normal.
    const depthAlongN = Math.abs(nx) > Math.abs(ny) ? fp.w : fp.h;
    const halfAlong = (Math.abs(nx) > Math.abs(ny) ? fp.h : fp.w) / 2;
    // Back sits at (wallInset + gap) inside the centreline = at the wall's inner face.
    const inset = depthAlongN / 2 + wallGap + wallInset;
    // Keep the ends off the perpendicular walls too.
    const from = halfAlong + wallInset, to = len - halfAlong - wallInset;
    for (let d = from; d <= to + 1e-6; d += step) {
      const px = a.x + ux * d + nx * inset;
      const py = a.y + uy * d + ny * inset;
      out.push({ cx: px, cy: py, rotation, againstWall: true });
    }
  }
  return out;
}

function gridCandidates(poly: Point[], step: number, rotations: number[]): Candidate[] {
  const { minX, maxX, minY, maxY } = bbox(poly);
  const out: Candidate[] = [];
  for (let x = minX + step / 2; x <= maxX; x += step)
    for (let y = minY + step / 2; y <= maxY; y += step)
      for (const rot of rotations)
        out.push({ cx: x, cy: y, rotation: rot, againstWall: false });
  return out;
}

// ─────────────────────────── core recommender ───────────────────────────

/**
 * Core placement search operating on raw geometry.
 * @param roomPolygon ordered polygon vertices (cm)
 * @param obstacles   footprints of existing furniture (cm)
 * @param keepClear   hard keep-out rects, e.g. door swing zones (cm)
 * @param item        {width, depth} of the piece to place (cm)
 */
export function recommendPlacement(
  roomPolygon: Point[],
  obstacles: Rect[],
  keepClear: Rect[],
  item: PlacementItem,
  options: PlacementOptions = {},
): PlacementResult | null {
  if (roomPolygon.length < 3) return null;
  const o = { ...DEFAULTS, ...options };
  const strategy = options.strategy ?? 'wall';
  const rotations = options.rotations ?? [0, 90];
  const wallInset = o.wallInset ?? 0;
  const centroid = polygonCentroid(roomPolygon);
  const { minX, maxX, minY, maxY } = bbox(roomPolygon);
  const roomDiag = Math.hypot(maxX - minX, maxY - minY) || 1;

  const candidates = [
    ...wallCandidates(roomPolygon, item, o.step, o.wallGap, wallInset),
    ...gridCandidates(roomPolygon, o.step, rotations),
  ];

  let best: PlacementResult | null = null;

  for (const c of candidates) {
    const fp = footprintOf(c.cx, c.cy, c.rotation, item);

    // ── hard constraints ──
    if (!rectInsidePolygon(fp, roomPolygon, wallInset)) continue;
    let blocked = false;
    for (const ob of obstacles) if (rectsOverlap(fp, ob, o.clearance)) { blocked = true; break; }
    if (blocked) continue;
    for (const kc of keepClear) if (rectsOverlap(fp, kc, 0)) { blocked = true; break; }
    if (blocked) continue;

    // ── soft score (higher = better) ──
    let openness = Infinity;
    for (const ob of obstacles) openness = Math.min(openness, gapBetween(fp, ob));
    if (!isFinite(openness)) openness = roomDiag; // empty room
    let doorDist = Infinity;
    for (const kc of keepClear) doorDist = Math.min(doorDist, gapBetween(fp, kc));
    if (!isFinite(doorDist)) doorDist = roomDiag;

    const opennessN = Math.min(openness, roomDiag) / roomDiag;
    const doorN = Math.min(doorDist, roomDiag) / roomDiag;
    const centerN = 1 - dist({ x: fp.cx, y: fp.cy }, centroid) / (roomDiag / 2 + 1);

    let score: number;
    if (strategy === 'center') {
      score = 3 * centerN + 1 * opennessN + 1 * doorN;
    } else if (strategy === 'clearance') {
      score = 3 * opennessN + 1 * doorN + (c.againstWall ? 0.3 : 0);
    } else { // 'wall' (default)
      score = (c.againstWall ? 2 : 0) + 1.2 * opennessN + 0.8 * doorN;
    }

    if (!best || score > best.score) {
      best = { position: { x: fp.cx, y: fp.cy }, rotation: c.rotation, score, footprint: fp, againstWall: c.againstWall };
    }
  }

  return best;
}

// ─────────────────────────── Floor convenience wrapper ───────────────────────────

/** Door swing / entry keep-clear rect in front of a door on the given wall. */
function doorKeepClear(door: Door, wall: Wall, depth: number): Rect | null {
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len, uy = dy / len;
  const cx = wall.start.x + ux * (len * door.position);
  const cy = wall.start.y + uy * (len * door.position);
  const horizontal = Math.abs(ux) > Math.abs(uy);
  // Keep-clear straddles the wall (± depth) so it blocks either swing side.
  return horizontal
    ? { cx, cy, w: door.width, h: depth * 2 }
    : { cx, cy, w: depth * 2, h: door.width };
}

/** Half the average wall thickness for a room — how far to stay off the centreline polygon. */
function roomWallInset(room: Room, walls: Wall[]): number {
  const rw = walls.filter(w => room.walls.includes(w.id));
  if (!rw.length) return 0;
  return rw.reduce((s, w) => s + (w.thickness || 0), 0) / rw.length / 2;
}

/**
 * Recommend a spot for `item` inside `room` on `floor`.
 * `existingFurniture` are footprints already placed (id + centre + dims + rotation).
 */
export function recommendPlacementForRoom(
  room: Room,
  walls: Wall[],
  doors: Door[],
  existingFurniture: { position: Point; rotation: number; width: number; depth: number }[],
  item: PlacementItem,
  options: PlacementOptions = {},
): PlacementResult | null {
  const poly = getRoomPolygon(room, walls);
  if (poly.length < 3) return null;

  const obstacles: Rect[] = existingFurniture
    .filter(f => pointInPolygon(f.position, poly))
    .map(f => footprintOf(f.position.x, f.position.y, f.rotation, { width: f.width, depth: f.depth }));

  const doorClear = options.doorClearance ?? DEFAULTS.doorClearance;
  const keepClear: Rect[] = [];
  for (const d of doors) {
    const w = walls.find(wl => wl.id === d.wallId);
    if (!w) continue;
    if (!room.walls.includes(w.id)) continue;
    const kc = doorKeepClear(d, w, doorClear);
    if (kc) keepClear.push(kc);
  }

  const opts = { ...options, wallInset: options.wallInset ?? roomWallInset(room, walls) };
  return recommendPlacement(poly, obstacles, keepClear, item, opts);
}

// ─────────────────────────── multi-item arrange (feature B) ───────────────────────────

export interface ArrangeItem { id: string; width: number; depth: number; }
export interface ArrangeResult { id: string; position: Point | null; rotation: number; }

/**
 * Tidy a whole room: greedily place every item against walls with no overlaps,
 * largest first. Items that can't fit get position: null (left where they were).
 */
export function arrangeRoom(
  room: Room,
  walls: Wall[],
  doors: Door[],
  items: ArrangeItem[],
  options: PlacementOptions = {},
): ArrangeResult[] {
  const poly = getRoomPolygon(room, walls);
  if (poly.length < 3) return items.map(it => ({ id: it.id, position: null, rotation: 0 }));

  const doorClear = options.doorClearance ?? DEFAULTS.doorClearance;
  const keepClear: Rect[] = [];
  for (const d of doors) {
    const w = walls.find(wl => wl.id === d.wallId);
    if (!w || !room.walls.includes(w.id)) continue;
    const kc = doorKeepClear(d, w, doorClear);
    if (kc) keepClear.push(kc);
  }

  const wallInset = options.wallInset ?? roomWallInset(room, walls);
  const placed: Rect[] = [...(options.fixedRects ?? [])];
  const results: ArrangeResult[] = [];
  // Place biggest footprints first — they need the good wall runs.
  const order = [...items].sort((a, b) => b.width * b.depth - a.width * a.depth);
  for (const it of order) {
    const res = recommendPlacement(poly, placed, keepClear, { width: it.width, depth: it.depth }, { strategy: 'wall', wallInset, ...options });
    if (res) {
      placed.push(res.footprint);
      results.push({ id: it.id, position: res.position, rotation: res.rotation });
    } else {
      results.push({ id: it.id, position: null, rotation: 0 });
    }
  }
  return results;
}


// ─────────────────────── keep-in-place helpers ───────────────────────

/** Axis-aligned bounding box of a (possibly rotated) furniture footprint. */
export function itemAabb(position: Point, rotation: number, width: number, depth: number): Rect {
  const a = ((rotation % 360) + 360) % 360 * Math.PI / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return { cx: position.x, cy: position.y, w: width * c + depth * s, h: width * s + depth * c };
}

/** Do two furniture AABBs overlap (with optional padding)? */
export function aabbsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + pad &&
         Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 + pad;
}

/**
 * Push a piece flush against the NEAREST wall (back to the wall surface) and
 * face it into the room. Uses the piece's ACTUAL width/depth, not catalog sizes.
 * Same maths/convention as the canvas drag wall-snap.
 */
export function flushToNearestWall(
  walls: Wall[], pos: Point, width: number, depth: number,
): { position: Point; rotation: number } | null {
  const halfDepth = depth / 2;
  let bestDist = Infinity;
  let best: { position: Point; rotation: number } | null = null;
  for (const wall of walls) {
    const wx = wall.end.x - wall.start.x, wy = wall.end.y - wall.start.y;
    const wLen = Math.hypot(wx, wy);
    if (wLen < Math.max(1, width * 0.5)) continue; // wall too short for this piece
    const ux = wx / wLen, uy = wy / wLen;
    const nx = -uy, ny = ux;
    const dx = pos.x - wall.start.x, dy = pos.y - wall.start.y;
    const along = dx * ux + dy * uy;
    const perp = dx * nx + dy * ny;
    if (along < -width / 2 || along > wLen + width / 2) continue;
    const wallHalfThickness = (wall.thickness ?? 15) / 2;
    const dist = Math.abs(Math.abs(perp) - wallHalfThickness);
    if (dist < bestDist) {
      bestDist = dist;
      const sign = perp >= 0 ? 1 : -1;
      const targetPerp = sign * (wallHalfThickness + halfDepth);
      const clampedAlong = Math.max(width / 2, Math.min(wLen - width / 2, along));
      const wallAngle = Math.atan2(wy, wx) * 180 / Math.PI;
      const rot = perp >= 0 ? wallAngle : wallAngle + 180;
      best = {
        position: {
          x: Math.round(wall.start.x + ux * clampedAlong + nx * targetPerp),
          y: Math.round(wall.start.y + uy * clampedAlong + ny * targetPerp),
        },
        rotation: ((rot % 360) + 360) % 360,
      };
    }
  }
  return best;
}

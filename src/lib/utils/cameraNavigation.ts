import type { Floor, FurnitureItem, Point, Room, Wall } from '$lib/models/types';
import { getCatalogItem } from '$lib/utils/furnitureCatalog';
import { pointInPolygon } from '$lib/utils/hitTesting';
import { detectRooms, getRoomPolygon, roomCentroid } from '$lib/utils/roomDetection';

export interface CameraRoomInfo {
  room: Room;
  polygon: Point[];
  center: Point;
}

export interface SafeCameraPlacement {
  position: Point;
  target: Point;
  room: CameraRoomInfo;
  wallClearance: number;
  furnitureClearance: number;
}

export interface CameraPathValidation {
  clear: boolean;
  doorCrossings: number;
  reason: 'solid-wall' | 'too-many-doors' | null;
}

function distanceToSegment(point: Point, wall: Wall): number {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - wall.start.x, point.y - wall.start.y);
  const t = Math.max(0, Math.min(1,
    ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / lengthSquared));
  return Math.hypot(
    point.x - (wall.start.x + t * dx),
    point.y - (wall.start.y + t * dy),
  );
}

function furnitureClearance(point: Point, item: FurnitureItem): number {
  const definition = getCatalogItem(item.catalogId);
  const width = (item.width ?? definition?.width ?? 60) * Math.abs(item.scale?.x ?? 1);
  const depth = (item.depth ?? definition?.depth ?? 60) * Math.abs(item.scale?.y ?? 1);
  const angle = -((item.rotation ?? 0) * Math.PI / 180);
  const dx = point.x - item.position.x;
  const dy = point.y - item.position.y;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  const outsideX = Math.abs(localX) - width / 2;
  const outsideY = Math.abs(localY) - depth / 2;
  if (outsideX <= 0 && outsideY <= 0) return Math.max(outsideX, outsideY);
  return Math.hypot(Math.max(0, outsideX), Math.max(0, outsideY));
}

export function getCameraRoomInfos(walls: Wall[]): CameraRoomInfo[] {
  return detectRooms(walls)
    .map((room) => ({ room, polygon: getRoomPolygon(room, walls) }))
    .filter((info) => info.polygon.length >= 3)
    .map((info) => ({ ...info, center: roomCentroid(info.polygon) }));
}

export function findCameraRoom(point: Point, rooms: CameraRoomInfo[]): CameraRoomInfo | null {
  const containing = rooms.filter((info) => pointInPolygon(point, info.polygon));
  containing.sort((a, b) => a.room.area - b.room.area);
  return containing[0] ?? null;
}

/** Find a camera position that is genuinely inside the selected room and clear of solids. */
export function findSafeCameraPlacement(
  floor: Floor,
  hit: Point,
  forcedRoom?: CameraRoomInfo,
): SafeCameraPlacement | null {
  const room = forcedRoom
    ?? (() => {
      const rooms = getCameraRoomInfos(floor.walls);
      return findCameraRoom(hit, rooms)
        ?? [...rooms].sort((a, b) =>
          Math.hypot(hit.x - a.center.x, hit.y - a.center.y)
          - Math.hypot(hit.x - b.center.x, hit.y - b.center.y))[0];
    })();
  if (!room) return null;

  const base = pointInPolygon(hit, room.polygon) ? hit : room.center;
  const candidates: Point[] = [base, room.center];
  for (const ratio of [0.15, 0.3, 0.45, 0.6, 0.8, 1]) {
    candidates.push({
      x: base.x + (room.center.x - base.x) * ratio,
      y: base.y + (room.center.y - base.y) * ratio,
    });
  }

  const xs = room.polygon.map((point) => point.x);
  const ys = room.polygon.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const gridStep = Math.max(20, Math.min(35, Math.max(maxX - minX, maxY - minY) / 18));
  for (let x = minX + gridStep / 2; x < maxX; x += gridStep) {
    for (let y = minY + gridStep / 2; y < maxY; y += gridStep) {
      candidates.push({ x, y });
    }
  }

  const scored = candidates
    .filter((point) => pointInPolygon(point, room.polygon))
    .map((point) => {
      const wallClearance = Math.min(...floor.walls.map((wall) =>
        distanceToSegment(point, wall) - (wall.thickness || 15) / 2));
      const itemClearance = floor.furniture.length === 0
        ? Infinity
        : Math.min(...floor.furniture.map((item) => furnitureClearance(point, item)));
      const distance = Math.hypot(point.x - base.x, point.y - base.y);
      return { point, wallClearance, furnitureClearance: itemClearance, distance };
    })
    .filter((item) => item.wallClearance >= 25 && item.furnitureClearance >= 10)
    .sort((a, b) => a.distance - b.distance
      || Math.min(b.wallClearance, b.furnitureClearance)
      - Math.min(a.wallClearance, a.furnitureClearance));

  const safe = scored[0];
  if (!safe) return null;

  let target = room.center;
  if (Math.hypot(target.x - safe.point.x, target.y - safe.point.y) < 80) {
    const horizontal = maxX - minX >= maxY - minY;
    const distance = Math.min(180, Math.max(90, (horizontal ? maxX - minX : maxY - minY) * 0.3));
    const optionA = horizontal
      ? { x: safe.point.x + distance, y: safe.point.y }
      : { x: safe.point.x, y: safe.point.y + distance };
    const optionB = horizontal
      ? { x: safe.point.x - distance, y: safe.point.y }
      : { x: safe.point.x, y: safe.point.y - distance };
    target = pointInPolygon(optionA, room.polygon)
      ? optionA
      : pointInPolygon(optionB, room.polygon) ? optionB : room.center;
  }

  return {
    position: safe.point,
    target,
    room,
    wallClearance: safe.wallClearance,
    furnitureClearance: safe.furnitureClearance,
  };
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

function segmentIntersection(
  start: Point,
  end: Point,
  wallStart: Point,
  wallEnd: Point,
): { pathT: number; wallT: number } | null {
  const path = { x: end.x - start.x, y: end.y - start.y };
  const wall = { x: wallEnd.x - wallStart.x, y: wallEnd.y - wallStart.y };
  const denominator = cross(path, wall);
  if (Math.abs(denominator) < 1e-8) return null;
  const offset = { x: wallStart.x - start.x, y: wallStart.y - start.y };
  const pathT = cross(offset, wall) / denominator;
  const wallT = cross(offset, path) / denominator;
  if (pathT <= 0.02 || pathT >= 0.98 || wallT < -0.001 || wallT > 1.001) return null;
  return { pathT, wallT };
}

function wallNavigationSegments(wall: Wall): Array<{ start: Point; end: Point; startT: number; endT: number }> {
  if (!wall.curvePoint) return [{ start: wall.start, end: wall.end, startT: 0, endT: 1 }];
  const segments = [];
  const steps = 16;
  const pointAt = (t: number): Point => {
    const oneMinusT = 1 - t;
    return {
      x: oneMinusT * oneMinusT * wall.start.x + 2 * oneMinusT * t * wall.curvePoint!.x + t * t * wall.end.x,
      y: oneMinusT * oneMinusT * wall.start.y + 2 * oneMinusT * t * wall.curvePoint!.y + t * t * wall.end.y,
    };
  };
  for (let index = 0; index < steps; index++) {
    const startT = index / steps;
    const endT = (index + 1) / steps;
    segments.push({ start: pointAt(startT), end: pointAt(endT), startT, endT });
  }
  return segments;
}

/** A navigation hop may stay in one room or cross one real doorway, never walls or several rooms. */
export function validateCameraPath(
  floor: Floor,
  start: Point,
  end: Point,
  maxDoorCrossings = 1,
): CameraPathValidation {
  let doorCrossings = 0;
  const crossedWalls = new Set<string>();

  for (const wall of floor.walls) {
    for (const segment of wallNavigationSegments(wall)) {
      const intersection = segmentIntersection(start, end, segment.start, segment.end);
      if (!intersection || crossedWalls.has(wall.id)) continue;
      crossedWalls.add(wall.id);
      const wallT = segment.startT + (segment.endT - segment.startT) * intersection.wallT;
      const wallLength = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
      const crossesDoor = floor.doors.some((door) =>
        door.wallId === wall.id
        && Math.abs(wallT - door.position) * wallLength <= door.width / 2 + 12);
      if (!crossesDoor) return { clear: false, doorCrossings, reason: 'solid-wall' };
      doorCrossings += 1;
      if (doorCrossings > maxDoorCrossings) {
        return { clear: false, doorCrossings, reason: 'too-many-doors' };
      }
      break;
    }
  }

  return { clear: true, doorCrossings, reason: null };
}

/**
 * Walk as far as safely possible along the tapped view direction. The camera
 * may pass through one real doorway, but stops before solid walls or a second
 * room transition instead of teleporting to a distant polygon.
 */
export function findReachableCameraPlacement(
  floor: Floor,
  start: Point,
  requested: Point,
  maxDistance = 600,
  maxDoorCrossings = 1,
): SafeCameraPlacement | null {
  const dx = requested.x - start.x;
  const dy = requested.y - start.y;
  const requestedDistance = Math.hypot(dx, dy);
  if (requestedDistance < 35) return null;

  const direction = { x: dx / requestedDistance, y: dy / requestedDistance };
  const furthest = Math.min(maxDistance, requestedDistance);
  const distances: number[] = [];
  for (let distance = furthest; distance >= 35; distance -= 20) distances.push(distance);
  if (distances[distances.length - 1] !== 35) distances.push(35);

  const rooms = getCameraRoomInfos(floor.walls);
  for (const distance of distances) {
    const point = {
      x: start.x + direction.x * distance,
      y: start.y + direction.y * distance,
    };
    const room = findCameraRoom(point, rooms);
    if (!room) continue;
    const placement = findSafeCameraPlacement(floor, point, room);
    if (!placement) continue;
    if (Math.hypot(placement.position.x - start.x, placement.position.y - start.y) < 25) continue;
    if (!validateCameraPath(floor, start, placement.position, maxDoorCrossings).clear) continue;
    return placement;
  }

  return null;
}

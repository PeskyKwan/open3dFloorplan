import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let vite;
let navigation;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  navigation = await vite.ssrLoadModule('/src/lib/utils/cameraNavigation.ts');
});

after(async () => {
  await vite?.close();
});

const walls = [
  { id: 'top', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 15, height: 280, color: '#fff' },
  { id: 'right', start: { x: 600, y: 0 }, end: { x: 600, y: 500 }, thickness: 15, height: 280, color: '#fff' },
  { id: 'bottom', start: { x: 600, y: 500 }, end: { x: 0, y: 500 }, thickness: 15, height: 280, color: '#fff' },
  { id: 'left', start: { x: 0, y: 500 }, end: { x: 0, y: 0 }, thickness: 15, height: 280, color: '#fff' },
  { id: 'bath-right', start: { x: 200, y: 300 }, end: { x: 200, y: 500 }, thickness: 15, height: 280, color: '#fff' },
  { id: 'bath-top', start: { x: 0, y: 300 }, end: { x: 200, y: 300 }, thickness: 15, height: 280, color: '#fff' },
  { id: 'store-right', start: { x: 150, y: 0 }, end: { x: 150, y: 120 }, thickness: 15, height: 280, color: '#fff' },
  { id: 'store-bottom', start: { x: 0, y: 120 }, end: { x: 150, y: 120 }, thickness: 15, height: 280, color: '#fff' },
];

const floor = {
  walls,
  doors: [
    { id: 'bath-door', wallId: 'bath-top', position: 0.5, width: 90, height: 210, type: 'single', swingDirection: 'left', flipSide: false },
    { id: 'store-door', wallId: 'store-bottom', position: 0.5, width: 100, height: 210, type: 'sliding', swingDirection: 'left', flipSide: false },
  ],
  furniture: [
    { id: 'toilet', catalogId: 'toilet', position: { x: 60, y: 400 }, rotation: 0, scale: { x: 1, y: 1, z: 1 } },
    { id: 'sink', catalogId: 'sink_b', position: { x: 60, y: 340 }, rotation: 0, scale: { x: 1, y: 1, z: 1 } },
  ],
};

// An anonymized RoomPlan topology captured from a real iPhone scan. RoomPlan
// leaves a 54 cm doorway gap in the left boundary and short doorway gaps where
// partitions stop before adjoining walls. The main floor is about 10.6 m².
const roomPlanGapWalls = [
  { id: 'rp-right', start: { x: 153, y: -145 }, end: { x: 153, y: 212 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-left-low', start: { x: -233, y: 54 }, end: { x: -233, y: -145 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-left-high', start: { x: -233, y: 212 }, end: { x: -233, y: 108 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-small-top', start: { x: -119, y: 135 }, end: { x: -154, y: 135 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-top', start: { x: 153, y: 212 }, end: { x: -233, y: 212 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-divider-low', start: { x: -120, y: -18 }, end: { x: -120, y: -145 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-bottom-left', start: { x: -233, y: -145 }, end: { x: -120, y: -145 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-bottom-main', start: { x: -120, y: -145 }, end: { x: 153, y: -145 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-zero', start: { x: -120, y: 53 }, end: { x: -120, y: 53 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-small-low-top', start: { x: -120, y: 53 }, end: { x: -233, y: 54 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-divider-high', start: { x: -119, y: 135 }, end: { x: -120, y: 53 }, thickness: 15, height: 264, color: '#fff' },
  { id: 'rp-divider-mid', start: { x: -120, y: 53 }, end: { x: -120, y: -18 }, thickness: 15, height: 264, color: '#fff' },
];

test('Studio Apartment resolves the screenshot space as tiny Room 1', () => {
  const rooms = navigation.getCameraRoomInfos(walls);
  assert.deepEqual(rooms.map((info) => [info.room.name, info.room.area]), [
    ['Room 1', 1.8],
    ['Room 2', 24.2],
    ['Room 3', 4],
  ]);
  assert.equal(navigation.findCameraRoom({ x: 75, y: 60 }, rooms)?.room.name, 'Room 1');
});

test('bathroom placement stays clear of walls and bathroom furniture', () => {
  const rooms = navigation.getCameraRoomInfos(walls);
  const bathroom = navigation.findCameraRoom({ x: 100, y: 400 }, rooms);
  const placement = navigation.findSafeCameraPlacement(floor, { x: 100, y: 400 }, bathroom);
  assert.ok(placement);
  assert.equal(placement.room.room.name, 'Room 3');
  assert.ok(placement.wallClearance >= 25);
  assert.ok(placement.furnitureClearance >= 10);
});

test('safe placement follows a clear tap instead of snapping back to room centre', () => {
  const rooms = navigation.getCameraRoomInfos(walls);
  const bathroom = navigation.findCameraRoom({ x: 140, y: 430 }, rooms);
  const placement = navigation.findSafeCameraPlacement(floor, { x: 140, y: 430 }, bathroom);
  assert.ok(placement);
  assert.deepEqual(placement.position, { x: 140, y: 430 });
});

test('one doorway is allowed but a solid wall is never crossed', () => {
  assert.deepEqual(
    navigation.validateCameraPath(floor, { x: 100, y: 200 }, { x: 150, y: 400 }),
    { clear: true, doorCrossings: 1, reason: null },
  );
  assert.deepEqual(
    navigation.validateCameraPath(floor, { x: 300, y: 400 }, { x: 150, y: 400 }),
    { clear: false, doorCrossings: 0, reason: 'solid-wall' },
  );
});

test('a single double tap cannot jump through several rooms', () => {
  assert.deepEqual(
    navigation.validateCameraPath(floor, { x: 100, y: 400 }, { x: 75, y: 60 }),
    { clear: false, doorCrossings: 2, reason: 'too-many-doors' },
  );
});

test('reachable placement stops in the adjacent room before a second doorway', () => {
  const placement = navigation.findReachableCameraPlacement(
    floor,
    { x: 100, y: 400 },
    { x: 75, y: 60 },
  );
  assert.ok(placement);
  assert.equal(placement.room.room.name, 'Room 2');
  assert.deepEqual(
    navigation.validateCameraPath(floor, { x: 100, y: 400 }, placement.position),
    { clear: true, doorCrossings: 1, reason: null },
  );
});

test('reachable placement stops before a solid wall instead of entering through it', () => {
  const placement = navigation.findReachableCameraPlacement(
    floor,
    { x: 300, y: 400 },
    { x: 100, y: 400 },
  );
  assert.ok(placement);
  assert.equal(placement.room.room.name, 'Room 2');
  assert.ok(placement.position.x > 200);
});

test('RoomPlan doorway gaps still produce the real main room floor', () => {
  const rooms = navigation.getCameraRoomInfos(roomPlanGapWalls);
  const mainRoom = navigation.findCameraRoom({ x: 0, y: 0 }, rooms);
  assert.ok(mainRoom);
  assert.equal(mainRoom.room.area, 10.61);
  assert.ok(mainRoom.polygon.length >= 4);
  assert.ok(mainRoom.room.walls.every((id) => !id.startsWith('__room-gap-')));

  const placement = navigation.findSafeCameraPlacement({
    walls: roomPlanGapWalls,
    doors: [],
    furniture: [],
  }, { x: 0, y: 0 }, mainRoom);
  assert.ok(placement);
  assert.ok(placement.wallClearance >= 25);
});

test('an actually open three-wall scan is not invented as a room', () => {
  const openWalls = [
    { id: 'open-left', start: { x: 0, y: 0 }, end: { x: 0, y: 300 }, thickness: 15, height: 260, color: '#fff' },
    { id: 'open-top', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 15, height: 260, color: '#fff' },
    { id: 'open-right', start: { x: 400, y: 0 }, end: { x: 400, y: 300 }, thickness: 15, height: 260, color: '#fff' },
  ];
  assert.deepEqual(navigation.getCameraRoomInfos(openWalls), []);
});

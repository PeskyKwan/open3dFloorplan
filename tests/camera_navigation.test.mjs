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

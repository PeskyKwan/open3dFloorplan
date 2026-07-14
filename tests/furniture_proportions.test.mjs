import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { furnitureCatalog } from '../src/lib/utils/furnitureCatalog.ts';
import { createFurnitureModel } from '../src/lib/utils/furnitureModels3d.ts';

const beds = ['bed_twin', 'bed_queen'].map((id) => {
  const item = furnitureCatalog.find((candidate) => candidate.id === id);
  assert.ok(item, `missing catalog item ${id}`);
  return item;
});

test('bed catalog dimensions use width side-to-side and depth head-to-foot', () => {
  for (const bed of beds) {
    assert.ok(bed.depth > bed.width, `${bed.id} must be longer than it is wide`);
    assert.ok(bed.depth / bed.width >= 1.3, `${bed.id} footprint must keep a realistic bed aspect ratio`);
  }
});

test('procedural bed fallback preserves the corrected catalog footprint', () => {
  for (const bed of beds) {
    const model = createFurnitureModel(bed.id, bed);
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(model).getSize(size);
    assert.ok(Math.abs(size.x - bed.width) < 0.001, `${bed.id} width drifted`);
    assert.ok(Math.abs(size.z - bed.depth) < 0.001, `${bed.id} depth drifted`);
  }
});

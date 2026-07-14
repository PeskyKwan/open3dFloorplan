import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAMERA_PREVIEW_ASPECT,
  horizontalToVerticalFOV,
  verticalToHorizontalFOV,
} from '../src/lib/utils/cameraProjection.ts';

const closeTo = (actual, expected, tolerance = 0.05) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

test('90 degree normal mode means 90 horizontal, not 90 vertical', () => {
  const vertical = horizontalToVerticalFOV(90, CAMERA_PREVIEW_ASPECT);
  closeTo(vertical, 58.72);
  closeTo(verticalToHorizontalFOV(vertical, CAMERA_PREVIEW_ASPECT), 90);
});

test('all camera presets round-trip as horizontal FOV values', () => {
  for (const horizontal of [65, 90, 120]) {
    const vertical = horizontalToVerticalFOV(horizontal, CAMERA_PREVIEW_ASPECT);
    closeTo(verticalToHorizontalFOV(vertical, CAMERA_PREVIEW_ASPECT), horizontal);
  }
  closeTo(horizontalToVerticalFOV(65, CAMERA_PREVIEW_ASPECT), 39.42);
  closeTo(horizontalToVerticalFOV(120, CAMERA_PREVIEW_ASPECT), 88.51);
});

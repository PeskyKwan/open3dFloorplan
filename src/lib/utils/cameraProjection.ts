export const CAMERA_PREVIEW_ASPECT = 16 / 9;

/** Convert a user-facing horizontal field of view to Three.js' vertical FOV. */
export function horizontalToVerticalFOV(horizontalDegrees: number, aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('Camera aspect ratio must be positive.');
  const horizontalRadians = horizontalDegrees * Math.PI / 180;
  return 2 * Math.atan(Math.tan(horizontalRadians / 2) / aspect) * 180 / Math.PI;
}

/** Convert Three.js' vertical field of view back to the user-facing horizontal FOV. */
export function verticalToHorizontalFOV(verticalDegrees: number, aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('Camera aspect ratio must be positive.');
  const verticalRadians = verticalDegrees * Math.PI / 180;
  return 2 * Math.atan(Math.tan(verticalRadians / 2) * aspect) * 180 / Math.PI;
}

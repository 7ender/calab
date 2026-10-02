/** Shift a horizontal composition just enough to contain a scaled card. */
export function fitCardShift(center: number, width: number, viewport: number, shift: number, padding = 24): number {
  const half = Math.min(width, Math.max(0, viewport - padding * 2)) / 2;
  const min = padding + half;
  const max = Math.max(min, viewport - padding - half);
  const visibleCenter = center + shift;
  return shift + Math.max(min, Math.min(max, visibleCenter)) - visibleCenter;
}

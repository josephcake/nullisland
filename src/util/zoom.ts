/**
 * ArcGIS scale <-> Google Maps zoom conversion.
 *
 * ArcGIS publishes `minScale` / `maxScale` as scale denominators at 96 DPI.
 * Web Mercator resolution at zoom 0 is 156 543.0339 m/px, so a scale
 * denominator maps to exactly one zoom level.
 */

const DPI = 96;
const METERS_PER_INCH = 0.0254;
const ZOOM0_RESOLUTION = 156543.03392804097;

export const MIN_ZOOM = 0;
export const MAX_ZOOM = 22;

/** Scale denominator -> zoom (fractional). */
export function scaleToZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return Number.NaN;
  const resolution = (scale * METERS_PER_INCH) / DPI;
  return Math.log2(ZOOM0_RESOLUTION / resolution);
}

export interface ZoomRange {
  minZoom: number;
  maxZoom: number;
}

/**
 * Convert an Esri scale range into a Google Maps zoom range.
 *
 * `minScale` is the most zoomed out scale (large denominator) and `maxScale`
 * the most zoomed in (small denominator). Zero means "unbounded".
 */
export function zoomRangeFromScales(
  minScale: number | null | undefined,
  maxScale: number | null | undefined,
): ZoomRange {
  let minZoom = MIN_ZOOM;
  let maxZoom = MAX_ZOOM;

  if (typeof minScale === 'number' && minScale > 0) {
    const zoom = scaleToZoom(minScale);
    if (Number.isFinite(zoom)) minZoom = clampZoom(Math.ceil(zoom));
  }
  if (typeof maxScale === 'number' && maxScale > 0) {
    const zoom = scaleToZoom(maxScale);
    if (Number.isFinite(zoom)) maxZoom = clampZoom(Math.floor(zoom));
  }

  if (maxZoom < minZoom) maxZoom = minZoom;
  return {minZoom, maxZoom};
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

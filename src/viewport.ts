import type {BBox} from './util/mercator.ts';
import {HALF_WORLD, WORLD_METERS, clampBBoxLatitude, metersToBbox} from './util/mercator.ts';

/** Snapshot of the Google Maps camera, in both pixel and geographic terms. */
export interface Viewport {
  zoom: number;
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  center: {lng: number; lat: number};
  /** EPSG:3857 metres, not padded. */
  bounds3857: [number, number, number, number];
  /** WGS84 degrees, not padded; may cross the antimeridian. */
  bounds4326: BBox;
}

export function readViewport(map: google.maps.Map, dpr: number): Viewport | null {
  const zoom = map.getZoom();
  const center = map.getCenter();
  const projection = map.getProjection();
  const div = map.getDiv();

  if (zoom === undefined || zoom === null || !center || !projection || !div) return null;

  const width = div.clientWidth || div.offsetWidth;
  const height = div.clientHeight || div.offsetHeight;
  if (!width || !height) return null;

  const point = projection.fromLatLngToPoint(center);
  if (!point) return null;

  const scale = 2 ** zoom;
  const centerX = point.x * scale;
  const centerY = point.y * scale;

  const left = centerX - width / 2;
  const right = centerX + width / 2;
  const top = centerY - height / 2;
  const bottom = centerY + height / 2;

  const metersPerPixel = WORLD_METERS / (256 * scale);
  const bounds3857: [number, number, number, number] = [
    -HALF_WORLD + left * metersPerPixel,
    HALF_WORLD - bottom * metersPerPixel,
    -HALF_WORLD + right * metersPerPixel,
    HALF_WORLD - top * metersPerPixel,
  ];

  return {
    zoom,
    width,
    height,
    dpr,
    center: {lng: center.lng(), lat: center.lat()},
    bounds3857,
    bounds4326: clampBBoxLatitude(metersToBbox(bounds3857)),
  };
}

/** Expand a bbox by a fraction of its width/height on every side. */
export function padBBox(bbox: BBox, padding: number): BBox {
  const [west, south, east, north] = bbox;
  const dx = (east - west) * padding;
  const dy = (north - south) * padding;
  return [west - dx, south - dy, east + dx, north + dy];
}

/** True when `outer` fully contains `inner`. */
export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[2] >= inner[2] &&
    outer[3] >= inner[3]
  );
}

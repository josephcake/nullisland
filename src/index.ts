/**
 * nullisland — ArcGIS layers on Google Maps.
 *
 * @packageDocumentation
 */

export {NullIsland} from './engine.ts';
export {
  deriveLayerId,
  normalizeLayer,
  normalizeLayers,
  parseServiceUrl,
  type NormalizedLayerConfig,
  type ServiceUrl,
} from './config.ts';
export {discoverService, type ArcGisRenderer, type ArcGisService, type ArcGisSublayer} from './discovery.ts';
export {
  NullIslandAbortError,
  NullIslandAuthError,
  NullIslandConfigError,
  NullIslandError,
  NullIslandHttpError,
  isAbortError,
} from './errors.ts';
export {decodeFeatureCollection, groupRings, NotPbfError, signedArea} from './pbf/decode.ts';
export {PbfReader} from './pbf/reader.ts';
export type {NullIslandEventMap, NullIslandLayer, NullIslandOptions, ArcGisLayerConfig, NullIslandStatus, LayerStatus} from './types.ts';
export type {BBox, LngLat} from './util/mercator.ts';
export {metersToBbox} from './util/mercator.ts';
export {scaleToZoom, zoomRangeFromScales} from './util/zoom.ts';
export {snapBBox} from './util/tiles.ts';

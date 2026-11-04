/**
 * Translate ArcGIS renderer metadata into Google Maps `Data` styles.
 *
 * Supported renderer types: simple, uniqueValue, classBreaks. Visual variables,
 * dash patterns, halos, labels and picture fills are intentionally not
 * translated; they degrade to the base symbol, which is still recognisable.
 */

import type {RGBA} from '../types.ts';
import {applyOpacity, rgbaToCss} from '../util/color.ts';
import type {ArcGisRenderer, ArcGisSymbol} from '../discovery.ts';

export interface StyleContext {
  renderer: ArcGisRenderer | null;
  color: RGBA | undefined;
  opacity: number;
  geometryType: string | null;
  google: typeof google | undefined;
}

export type StyleResolver = (feature: google.maps.Data.Feature) => google.maps.Data.StyleOptions;

const DEFAULT_COLOR: RGBA = [0, 102, 255, 255];

export function createStyleResolver(context: StyleContext): StyleResolver {
  if (context.color) {
    const style = styleForColor(context.color, context.opacity, context.geometryType, context.google);
    return () => style;
  }

  const renderer = context.renderer;
  if (!renderer) {
    const style = styleForColor(DEFAULT_COLOR, context.opacity, context.geometryType, context.google);
    return () => style;
  }

  const defaultSymbol = renderer.symbol ?? renderer.defaultSymbol ?? null;
  const fallback = symbolToStyle(defaultSymbol, context);

  if (renderer.type === 'uniqueValue' && Array.isArray(renderer.uniqueValueInfos)) {
    const styles = new Map<string, google.maps.Data.StyleOptions>();
    for (const info of renderer.uniqueValueInfos) {
      if (info.value === undefined) continue;
      styles.set(String(info.value), symbolToStyle(info.symbol ?? defaultSymbol, context));
    }
    const field = renderer.field1;
    if (field) {
      return (feature) => styles.get(String(feature.getProperty(field))) ?? fallback;
    }
  }

  if (renderer.type === 'classBreaks' && Array.isArray(renderer.classBreakInfos)) {
    const breaks = renderer.classBreakInfos
      .filter((info) => typeof info.classMinValue === 'number')
      .map((info) => ({
        min: info.classMinValue as number,
        max: typeof info.classMaxValue === 'number' ? info.classMaxValue : Number.POSITIVE_INFINITY,
        style: symbolToStyle(info.symbol ?? defaultSymbol, context),
      }));
    const field = renderer.field1;
    if (field && breaks.length > 0) {
      return (feature) => {
        const value = Number(feature.getProperty(field));
        if (!Number.isFinite(value)) return fallback;
        const match = breaks.find((entry) => value >= entry.min && value <= entry.max);
        return match?.style ?? fallback;
      };
    }
  }

  return () => fallback;
}

function symbolToStyle(symbol: ArcGisSymbol | null, context: StyleContext): google.maps.Data.StyleOptions {
  if (!symbol) {
    return styleForColor(DEFAULT_COLOR, context.opacity, context.geometryType, context.google);
  }

  const fill = colorToRgba(symbol.color, DEFAULT_COLOR);
  const outline = symbol.outline;
  const stroke = colorToRgba(outline?.color, [0, 0, 0, 255]);
  const isPoint = symbol.type === 'esriSMS' || context.geometryType === 'esriGeometryPoint' || context.geometryType === 'esriGeometryMultipoint';

  if (isPoint) {
    const size = clampNumber(symbol.size ?? 8, 4, 48);
    return {
      ...pointIcon(context.google, applyOpacity(fill, context.opacity), size, outline?.width ?? 1),
      fillColor: rgbaToCss(applyOpacity(fill, context.opacity)),
      fillOpacity: 1,
      strokeColor: rgbaToCss(applyOpacity(stroke, context.opacity)),
      strokeWeight: outline?.width ?? 1,
    };
  }

  if (context.geometryType === 'esriGeometryPolyline' || symbol.type === 'esriSLS') {
    return {
      strokeColor: rgbaToCss(applyOpacity(fill, context.opacity)),
      strokeOpacity: 1,
      strokeWeight: clampNumber(symbol.width ?? 1.5, 0.5, 20),
      fillOpacity: 0,
    };
  }

  return {
    fillColor: rgbaToCss(applyOpacity(fill, context.opacity)),
    fillOpacity: 1,
    strokeColor: rgbaToCss(applyOpacity(stroke, context.opacity)),
    strokeOpacity: 1,
    strokeWeight: clampNumber(outline?.width ?? 1, 0, 10),
  };
}

function styleForColor(
  color: RGBA,
  opacity: number,
  geometryType: string | null,
  googleApi: typeof google | undefined,
): google.maps.Data.StyleOptions {
  const fill = applyOpacity(color, opacity);
  if (geometryType === 'esriGeometryPolyline') {
    return {strokeColor: rgbaToCss(fill), strokeOpacity: 1, strokeWeight: 2, fillOpacity: 0};
  }
  if (geometryType === 'esriGeometryPoint' || geometryType === 'esriGeometryMultipoint') {
    return {
      ...pointIcon(googleApi, fill, 8, 1),
      fillColor: rgbaToCss(fill),
      strokeColor: rgbaToCss(applyOpacity([0, 0, 0, 255], opacity)),
      strokeWeight: 1,
    };
  }
  return {
    fillColor: rgbaToCss(fill),
    fillOpacity: 1,
    strokeColor: rgbaToCss(applyOpacity(darken(color), opacity)),
    strokeOpacity: 1,
    strokeWeight: 1,
  };
}

function pointIcon(
  googleApi: typeof google | undefined,
  fill: RGBA,
  size: number,
  strokeWidth: number,
): google.maps.Data.StyleOptions {
  if (!googleApi?.maps?.Size || !googleApi.maps.Point) return {};
  const radius = size / 2 - strokeWidth / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${Math.max(radius, 1)}" fill="${rgbaToCss(fill)}" stroke="rgba(0,0,0,0.55)" stroke-width="${strokeWidth}"/></svg>`;
  return {
    icon: {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize: new googleApi.maps.Size(size, size),
      anchor: new googleApi.maps.Point(size / 2, size / 2),
    },
  };
}

function colorToRgba(color: number[] | undefined, fallback: RGBA): RGBA {
  if (!Array.isArray(color) || color.length < 3) return fallback;
  const [r = fallback[0], g = fallback[1], b = fallback[2], a = 255] = color;
  return [clampChannel(r), clampChannel(g), clampChannel(b), clampChannel(a)];
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function darken([r, g, b, a]: RGBA): RGBA {
  return [Math.round(r * 0.6), Math.round(g * 0.6), Math.round(b * 0.6), a];
}

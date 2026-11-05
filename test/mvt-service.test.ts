import {describe, expect, it} from 'vitest';
import {discoverVectorTileService, parseStyleLayers} from '../src/mvt/service.ts';
import {parseServiceUrl} from '../src/config.ts';
import type {HttpClient} from '../src/http.ts';

const serviceUrl =
  'https://example.com/arcgis/rest/services/Parcels/VectorTileServer';

describe('parseStyleLayers', () => {
  it('translates fill and line layers', () => {
    const layers = parseStyleLayers({
      layers: [
        {
          id: 'parcels',
          type: 'fill',
          'source-layer': 'Parcels',
          paint: {'fill-color': '#e4572e', 'fill-opacity': 0.6, 'fill-outline-color': '#000'},
        },
        {
          id: 'roads',
          type: 'line',
          'source-layer': 'Roads',
          paint: {'line-color': 'rgb(1, 2, 3)', 'line-width': 2},
          minzoom: 8,
        },
        {id: 'labels', type: 'symbol', 'source-layer': 'Labels'},
      ],
    });

    expect(layers).toHaveLength(2);
    expect(layers[0]).toMatchObject({
      sourceLayer: 'Parcels',
      type: 'fill',
      fillColor: '#e4572e',
      fillOpacity: 0.6,
    });
    expect(layers[1]).toMatchObject({
      sourceLayer: 'Roads',
      type: 'line',
      lineColor: 'rgb(1, 2, 3)',
      lineWidth: 2,
      minZoom: 8,
    });
  });

  it('ignores expression colours', () => {
    const [layer] = parseStyleLayers({
      layers: [{id: 'x', type: 'fill', 'source-layer': 'X', paint: {'fill-color': ['interpolate', 1]}}],
    });
    expect(layer?.fillColor).toBeUndefined();
  });
});

describe('discoverVectorTileService', () => {
  it('reads tiles, lods and the style document', async () => {
    const http = {
      json: async (url: string) =>
        url.endsWith('/resources/styles/root.json')
          ? {version: 8, layers: [{id: 'p', type: 'fill', 'source-layer': 'Parcels', paint: {'fill-color': '#f00'}}]}
          : {
              name: 'Parcels',
              tiles: ['tile/{z}/{y}/{x}.pbf'],
              tileInfo: {lods: [{level: 0}, {level: 14}]},
              fullExtent: {
                xmin: -13240863.776,
                ymin: 4023715.14,
                xmax: -13173870.3567,
                ymax: 4054853.8936,
                spatialReference: {latestWkid: 3857},
              },
            },
    } as unknown as HttpClient;

    const service = await discoverVectorTileService(parseServiceUrl(serviceUrl), http);
    expect(service.tileTemplate).toBe('tile/{z}/{y}/{x}.pbf');
    expect(service.minZoom).toBe(0);
    expect(service.maxZoom).toBe(14);
    expect(service.styleLayers[0]?.sourceLayer).toBe('Parcels');
    expect(service.fullExtent?.[0]).toBeCloseTo(-118.94, 1);
    expect(service.fullExtent?.[3]).toBeCloseTo(34.19, 1);
  });
});

import {describe, expect, it} from 'vitest';
import {discoverService} from '../src/discovery.ts';
import {parseServiceUrl} from '../src/config.ts';
import type {HttpClient} from '../src/http.ts';

const serviceUrl = 'https://example.com/arcgis/rest/services/Test/FeatureServer';

function fakeHttp(service: Record<string, unknown>, layer: Record<string, unknown>): HttpClient {
  return {
    json: async (url: string) => (url.endsWith('/0') ? layer : service),
  } as unknown as HttpClient;
}

describe('discoverService capabilities', () => {
  it('reads advertised query formats', async () => {
    const http = fakeHttp(
      {
        currentVersion: 10.91,
        capabilities: 'Query',
        supportedQueryFormats: 'JSON, geoJSON, PBF',
        maxRecordCount: 1000,
        layers: [{id: 0, name: 'Parcels', minScale: 0, maxScale: 0}],
      },
      {
        id: 0,
        name: 'Parcels',
        advancedQueryCapabilities: {supportsPagination: true},
        supportsAdvancedQueries: true,
        maxRecordCount: 1000,
      },
    );

    const service = await discoverService(parseServiceUrl(serviceUrl), http);
    expect(service.queryFormats).toEqual(['json', 'geojson', 'pbf']);
    expect(service.sublayers[0]!.supportsPbf).toBe(true);
    expect(service.sublayers[0]!.supportsGeoJson).toBe(true);
    expect(service.sublayers[0]!.supportsPagination).toBe(true);
  });

  it('probes PBF on modern FeatureServers even when not advertised', async () => {
    const http = fakeHttp(
      {
        currentVersion: 10.91,
        capabilities: 'Query',
        supportedQueryFormats: 'JSON',
        maxRecordCount: 1000,
        layers: [{id: 0, name: 'A'}],
      },
      {id: 0, name: 'A'},
    );

    const service = await discoverService(parseServiceUrl(serviceUrl), http);
    expect(service.sublayers[0]!.supportsPbf).toBe('unknown');
    expect(service.sublayers[0]!.supportsGeoJson).toBe(false);
  });

  it('reads the layer document for a single-layer url', async () => {
    const http = {
      json: async (url: string) =>
        url.endsWith('/9')
          ? {
              id: 9,
              name: 'Severe',
              geometryType: 'esriGeometryPolygon',
              objectIdField: 'OBJECTID',
              maxRecordCount: 2000,
              supportedQueryFormats: 'JSON,geoJSON,PBF',
              advancedQueryCapabilities: {supportsPagination: true},
            }
          : {
              currentVersion: 12,
              capabilities: 'Query',
              supportedQueryFormats: 'JSON',
              layers: [{id: 9, name: 'Severe'}],
            },
    } as unknown as HttpClient;

    const service = await discoverService(parseServiceUrl(`${serviceUrl}/9`), http);
    expect(service.singleLayer).toBe(true);
    expect(service.sublayers[0]!.geometryType).toBe('esriGeometryPolygon');
    expect(service.sublayers[0]!.objectIdField).toBe('OBJECTID');
    expect(service.sublayers[0]!.supportsPbf).toBe(true);
  });

  it('respects servers that disable pagination', async () => {
    const http = fakeHttp(
      {
        currentVersion: 10.91,
        capabilities: 'Query',
        supportedQueryFormats: 'JSON,geoJSON',
        layers: [{id: 0, name: 'A'}],
      },
      {id: 0, name: 'A', advancedQueryCapabilities: {supportsPagination: false}},
    );

    const service = await discoverService(parseServiceUrl(serviceUrl), http);
    expect(service.sublayers[0]!.supportsPagination).toBe(false);
  });
});

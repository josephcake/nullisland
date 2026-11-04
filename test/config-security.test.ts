import {describe, expect, it} from 'vitest';
import {parseServiceUrl, normalizeLayers} from '../src/config.ts';

describe('url safety', () => {
  const base = 'example.com/arcgis/rest/services/A/FeatureServer';

  it('rejects plain http', () => {
    expect(() => parseServiceUrl(`http://${base}`)).toThrow(/https/);
  });

  it('allows localhost over http', () => {
    expect(parseServiceUrl(`http://localhost:6080/arcgis/rest/services/A/FeatureServer`).kind).toBe('FeatureServer');
    expect(parseServiceUrl(`http://127.0.0.1/arcgis/rest/services/A/MapServer`).kind).toBe('MapServer');
  });

  it('allows http when explicitly permitted', () => {
    const parsed = parseServiceUrl(`http://${base}`, {allowInsecure: true});
    expect(parsed.base).toBe(`http://${base}`);
  });

  it('rejects embedded credentials', () => {
    expect(() => parseServiceUrl(`https://user:pass@${base}`)).toThrow(/credentials/);
  });

  it('applies the same policy through normalizeLayers', () => {
    const {errors} = normalizeLayers([{url: `http://${base}`}]);
    expect(errors).toHaveLength(1);

    const allowed = normalizeLayers([{url: `http://${base}`}], {allowInsecure: true});
    expect(allowed.errors).toHaveLength(0);
    expect(allowed.layers).toHaveLength(1);
  });
});

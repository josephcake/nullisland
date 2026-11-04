import {describe, expect, it} from 'vitest';
import {HttpClient} from '../src/http.ts';
import {NullIslandAuthError} from '../src/errors.ts';

const noopFetch = (async () => new Response('{}', {status: 200})) as typeof fetch;

describe('HttpClient tokens', () => {
  it('does not append a token when none is configured', async () => {
    const http = new HttpClient({fetch: noopFetch});
    const url = await http.url('https://example.com/arcgis/rest/services/A/FeatureServer/0/query', {f: 'json'});
    expect(url).not.toContain('token=');
  });

  it('appends a configured token', async () => {
    const http = new HttpClient({fetch: noopFetch, token: 'abc123'});
    const url = await http.url('https://example.com/x', {f: 'json'});
    expect(url).toContain('token=abc123');
  });

  it('explains how to fix a token-required response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({error: {code: 499, message: 'Token Required'}}), {
        status: 499,
        headers: {'content-type': 'application/json'},
      })) as unknown as typeof fetch;

    const http = new HttpClient({fetch: fetchImpl});
    await expect(http.json('https://example.com/x')).rejects.toBeInstanceOf(NullIslandAuthError);
    await expect(http.json('https://example.com/x')).rejects.toThrow(/apiKey/);
  });
});

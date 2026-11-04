import {describe, expect, it} from 'vitest';
import {LRU} from '../src/util/lru.ts';

describe('LRU', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LRU<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('rejects a bad capacity', () => {
    expect(() => new LRU(0)).toThrow(RangeError);
  });
});

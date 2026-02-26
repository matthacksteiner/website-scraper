import { describe, expect, it } from 'bun:test';
import { createScopeFilter, normalizeUrl } from '../src/url';

describe('normalizeUrl', () => {
  it('removes hash and trailing slash', () => {
    expect(normalizeUrl('https://example.com/path/#section')).toBe(
      'https://example.com/path',
    );
  });
});

describe('createScopeFilter', () => {
  it('enforces same-origin scope', () => {
    const filter = createScopeFilter('https://example.com', 'same-origin', [], []);
    expect(filter('https://example.com/about')).toBe(true);
    expect(filter('https://cdn.example.com/about')).toBe(false);
  });

  it('applies custom include and exclude globs', () => {
    const filter = createScopeFilter(
      'https://example.com',
      'custom',
      ['https://example.com/blog/**'],
      ['**/draft/**'],
    );
    expect(filter('https://example.com/blog/post-1')).toBe(true);
    expect(filter('https://example.com/blog/draft/post-2')).toBe(false);
    expect(filter('https://example.com/shop/product')).toBe(false);
  });
});

/**
 * Cache-Control on the built client — STATIC-001 onwards.
 *
 * The rule these pin down is not "cache more", it is the pair: the entry HTML
 * stays uncacheable (#121, stale index.html pins a browser to bundles that no
 * longer exist) and the content-hashed files it names become immutable. Before
 * this, only the first half existed and everything else inherited
 * express.static's `max-age=0`, which is why a CDN in front of an instance
 * cached nothing at all.
 */
import { describe, it, expect } from 'vitest';
import { cacheControlFor } from '../../../src/nest/platform/platform.routes';

describe('cacheControlFor', () => {
  it('STATIC-001: index.html is never cached, wherever it is served from', () => {
    for (const p of ['/app/server/public/index.html', 'C:\\app\\server\\public\\index.html']) {
      expect(cacheControlFor(p)).toBe('no-cache, no-store, must-revalidate');
    }
  });

  it('STATIC-002: a hashed bundle is immutable for a year', () => {
    expect(cacheControlFor('/app/server/public/assets/vendor-react-DvgPkayR.js'))
      .toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('/app/server/public/assets/AdminPage-C2ncJ4o2.js'))
      .toBe('public, max-age=31536000, immutable');
  });

  it('STATIC-003: the same rule holds on Windows separators', () => {
    expect(cacheControlFor('C:\\app\\server\\public\\assets\\index-B4JsGSN2.js'))
      .toBe('public, max-age=31536000, immutable');
  });

  it('STATIC-004: names that survive a deploy get an hour, not a year', () => {
    // Replacing one of these keeps the URL, so a year would pin the old bytes.
    for (const p of [
      '/app/server/public/icons/apple-touch-icon-180x180.png',
      '/app/server/public/fonts/inter.woff2',
      '/app/server/public/theme-boot.js',
      '/app/server/public/manifest.webmanifest',
    ]) {
      expect(cacheControlFor(p)).toBe('public, max-age=3600');
    }
  });

  it('STATIC-005: "assets" as part of some other name is not the bundle dir', () => {
    expect(cacheControlFor('/app/server/public/images/assets-overview.png'))
      .toBe('public, max-age=3600');
  });
});

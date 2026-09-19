/**
 * The `/_AMapService` proxy — AMAP-120 onwards.
 *
 * This route exists so the Amap 安全密钥 never reaches a browser, so the cases
 * worth having are the ones where it could leak or be spent: the secret goes
 * out and never comes back, an unconfigured instance says so instead of
 * forwarding without it, a third party's Set-Cookie does not land on the app's
 * own domain, and a path this proxy was not built for is refused rather than
 * answered with the operator's credential attached.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/ssrfGuard', () => ({
  safeFetchFollow: vi.fn(),
}));

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));

import { AmapProxyController } from '../../../src/nest/maps/amap-proxy.controller';
import { safeFetchFollow } from '../../../src/utils/ssrfGuard';
import type { RateLimitService } from '../../../src/nest/common/rate-limit.service';
import type { SettingsService } from '../../../src/nest/settings/settings.service';

const SECRET = 'test-js-security-code';
const USER = { id: 7 } as never;

function controller(allowed = true, secret: string | null = SECRET): AmapProxyController {
  const rl = { check: vi.fn(() => allowed) } as unknown as RateLimitService;
  const settings = { resolveSecretSetting: vi.fn(() => secret) } as unknown as SettingsService;
  return new AmapProxyController(rl, settings);
}

/** A request the way Express hands it over, with the wildcard already split out. */
function request(path: string, query = ''): any {
  return {
    ip: '203.0.113.5',
    params: { path: path.replace(/^\//, '') },
    originalUrl: `/_AMapService${path}${query ? `?${query}` : ''}`,
  };
}

function response() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 0,
    body: null as unknown,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    status(code: number) { this.statusCode = code; return this; },
    send(body: unknown) { this.body = body; return this; },
  };
}

function upstream(body: string, headers: Record<string, string> = {}, status = 200) {
  const map = new Map(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n: string) => map.get(n.toLowerCase()) ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

/** The URL the one forwarded call was made with. */
function calledUrl(): string {
  return String((safeFetchFollow as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
}

beforeEach(() => {
  vi.mocked(safeFetchFollow).mockReset();
});

describe('AmapProxyController', () => {
  it('AMAP-120: appends jscode server-side and never echoes it back', async () => {
    vi.mocked(safeFetchFollow).mockResolvedValue(upstream('cb({"status":"1"})') as never);
    const res = response();
    await controller().forward(USER, request('/v3/log/init', 'key=abc&callback=cb_1') as never, res as never);

    const url = calledUrl();
    expect(url).toContain(`jscode=${SECRET}`);
    expect(url.startsWith('https://restapi.amap.com/v3/log/init?')).toBe(true);
    // The caller's own query survives byte-for-byte: Amap's JSONP callback name
    // is in it, and a re-serialised object does not promise that.
    expect(url).toContain('key=abc&callback=cb_1');
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).not.toContain(SECRET);
  });

  it('AMAP-121: custom map styles go to the other host Amap documents', async () => {
    vi.mocked(safeFetchFollow).mockResolvedValue(upstream('{}') as never);
    await controller().forward(USER, request('/v4/map/styles', 's=1') as never, response() as never);
    expect(calledUrl().startsWith('https://webapi.amap.com/v4/map/styles?')).toBe(true);
  });

  it('AMAP-122: an instance with no security code says so instead of forwarding without it', async () => {
    // Forwarding anyway would answer 200 with a refusal body, and the map would
    // render nothing while every layer of this stack reported success.
    await expect(controller(true, null).forward(USER, request('/v3/log/init') as never, response() as never))
      .rejects.toMatchObject({ status: 503 });
    expect(safeFetchFollow).not.toHaveBeenCalled();
  });

  it('AMAP-123: only Amap\'s versioned API paths are forwarded', async () => {
    for (const path of ['/internal/secrets', '/v3/../../etc/passwd', '/', '/v3']) {
      await expect(controller().forward(USER, request(path) as never, response() as never))
        .rejects.toMatchObject({ status: 404 });
    }
    expect(safeFetchFollow).not.toHaveBeenCalled();
  });

  it('AMAP-124: a third party\'s Set-Cookie does not land on this app\'s domain', async () => {
    // Amap sets acw_tc/cdn_sec_tc on its own answers. This route is same-origin
    // with the session, so a blanket header passthrough would write them onto it.
    vi.mocked(safeFetchFollow).mockResolvedValue(
      upstream('cb({})', { 'set-cookie': 'acw_tc=abc; path=/', 'content-type': 'application/javascript' }) as never,
    );
    const res = response();
    await controller().forward(USER, request('/v3/log/init') as never, res as never);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-type']).toBe('application/javascript');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('AMAP-125: the limiter guards a route that spends the operator\'s quota', async () => {
    await expect(controller(false).forward(USER, request('/v3/log/init') as never, response() as never))
      .rejects.toMatchObject({ status: 429 });
    expect(safeFetchFollow).not.toHaveBeenCalled();
  });
});

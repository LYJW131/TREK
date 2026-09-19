/**
 * Unit tests for the Amap (高德) transit backend — AMAP-100 onwards, continuing
 * the numbering the places provider's cases started.
 *
 * The routing fixture is a real `/v5/direction/transit/integrated` answer
 * (Suzhou 观前街 → 独墅湖, metro line 6 changing to line 8), trimmed to the
 * fields this provider reads. It is kept verbatim where it matters, because
 * three of the things worth testing here are properties of Amap's actual
 * wording and encoding rather than of our types:
 *
 *  - the datum: every coordinate arrives GCJ-02 and must leave WGS-84,
 *  - the clock: Amap publishes no departure, so the times on an itinerary are
 *    derived from the moment that was searched for and have to add up,
 *  - `轨道交通6号线(苏州新区火车站--桑田岛)`: one string carrying two fields.
 *
 * fetch is stubbed and the database is mocked, the same way maps.amap.test.ts
 * does it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { gcj02ToWgs84 } from '@trek/shared';

const { mockAppSettings } = vi.hoisted(() => ({
  mockAppSettings: vi.fn((..._args: unknown[]) => undefined as any),
}));

vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => (sql.includes('app_settings') ? mockAppSettings(...args) : undefined),
      all: vi.fn(() => []),
      run: vi.fn(),
    }),
  },
}));

vi.mock('../../../src/utils/ssrfGuard', () => {
  class SsrfBlockedError extends Error {}
  return {
    SsrfBlockedError,
    checkSsrf: vi.fn(async () => ({ allowed: true })),
    safeFetchFollow: vi.fn(async (url: string, init?: any) => (globalThis.fetch as any)(url, init)),
  };
});

vi.mock('../../../src/nest/common/crypto/apiKeyCrypto', () => ({
  decrypt_api_key: (v: string | null) => v,
  maybe_encrypt_api_key: (v: string | null) => v,
}));

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));

import { db } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { AmapTransitProvider, clearAmapTransitCache } from '../../../src/nest/transit/amap-transit.provider';
import { decodePolyline } from '../../../src/nest/transit/transit.helpers';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** 09:00 on 2 October in Suzhou, which is what the picker sends for that day. */
const ANCHOR = '2026-10-02T01:00:00.000Z';

const SUZHOU_METRO = {
  status: '1',
  info: 'OK',
  infocode: '10000',
  route: {
    transits: [
      {
        cost: { duration: '2907' },
        segments: [
          {
            walking: {
              origin: '120.627937,31.309986',
              destination: '120.630455,31.308681',
              distance: '495',
              cost: { duration: '481' },
              steps: [
                { polyline: { polyline: '120.627937,31.309986;120.628067,31.309418' } },
                { polyline: { polyline: '120.628067,31.309414;120.628975,31.309580' } },
              ],
            },
            bus: {
              buslines: [
                {
                  departure_stop: { name: '临顿路', location: '120.630459,31.308679' },
                  arrival_stop: { name: '琼姬墩', location: '120.725610,31.308593' },
                  name: '轨道交通6号线(苏州新区火车站--桑田岛)',
                  type: '地铁线路',
                  distance: '9662',
                  cost: { duration: '1080' },
                  polyline: { polyline: '120.630459,31.308679;120.630628,31.307875;120.631363,31.304834' },
                  via_stops: [
                    { name: '望星桥苏大' }, { name: '徐家浜' }, { name: '惹云桥' }, { name: '秋塘浜' }, { name: '李公堤西' },
                  ],
                },
              ],
            },
          },
          {
            walking: {
              origin: '120.725609,31.308590',
              destination: '120.725441,31.309874',
              distance: '170',
              cost: { duration: '289' },
              steps: [{ polyline: { polyline: '120.725609,31.308590;120.725700,31.309100' } }],
            },
            bus: {
              buslines: [
                {
                  departure_stop: { name: '琼姬墩', location: '120.725443,31.309878' },
                  arrival_stop: { name: '松涛街', location: '120.741026,31.263385' },
                  name: '轨道交通8号线(西津桥--车坊)',
                  type: '地铁线路',
                  distance: '5912',
                  cost: { duration: '750' },
                  polyline: { polyline: '120.725443,31.309878;120.725927,31.309704;120.728679,31.308916' },
                  via_stops: [{ name: '斜塘' }, { name: '莲池桥' }, { name: '仁爱路' }],
                },
              ],
            },
          },
          {
            walking: {
              origin: '120.741028,31.263382',
              destination: '120.739990,31.263016',
              distance: '357',
              cost: { duration: '307' },
              steps: [{ polyline: { polyline: '120.741028,31.263382;120.740100,31.263200' } }],
            },
          },
        ],
      },
    ],
  },
};

/**
 * The bus case, and the one that shows why only the first busline becomes a
 * leg: Amap lists every route serving the same pair of stops as a parallel
 * entry, so four numbers here are one ride, not four.
 */
const PARALLEL_BUSES = {
  status: '1',
  info: 'OK',
  infocode: '10000',
  route: {
    transits: [
      {
        // Deliberately longer than the 900s the segments add up to: the missing
        // 300s is the wait for the first bus, which no segment carries.
        cost: { duration: '1200' },
        segments: [
          {
            bus: {
              buslines: [
                {
                  departure_stop: { name: '市一中', location: '120.620000,31.300000' },
                  arrival_stop: { name: '烽火路北', location: '120.650000,31.290000' },
                  name: '9路(官渎里立交换乘枢纽站--新庄立交换乘枢纽站)',
                  type: '普通公交线路',
                  distance: '3400',
                  cost: { duration: '900' },
                  via_stops: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
                },
                {
                  departure_stop: { name: '市一中', location: '120.620000,31.300000' },
                  arrival_stop: { name: '烽火路北', location: '120.650000,31.290000' },
                  name: '60路(南线)(梅亭苑--梅亭苑)',
                  type: '普通公交线路',
                  distance: '3400',
                  cost: { duration: '900' },
                  via_stops: [],
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

const REGEO_SUZHOU = {
  status: '1',
  info: 'OK',
  infocode: '10000',
  regeocode: { addressComponent: { citycode: '0512', adcode: '320508' } },
};

/** A coordinate Amap places outside any city — its `citycode`/`adcode` come back empty. */
const REGEO_NOWHERE = {
  status: '1',
  info: 'OK',
  infocode: '10000',
  regeocode: { addressComponent: { citycode: [], adcode: [] } },
};

// ── harness ──────────────────────────────────────────────────────────────────

/** app_settings answers both the provider switch and the key lookup, keyed by name. */
function settings({ provider = 'amap', key = 'amap-test-key' }: { provider?: string | null; key?: string | null } = {}) {
  mockAppSettings.mockImplementation((name: unknown) => {
    if (name === 'transit_provider') return provider === null ? undefined : { value: provider };
    if (name === 'amap_api_key') return key === null ? undefined : { value: key };
    return undefined;
  });
}

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** Routes each stubbed call by path, so a plan's two geocodes and its routing call can differ. */
function stubAmap(routing: unknown, regeo: unknown = REGEO_SUZHOU) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/geocode/regeo')) return json(regeo);
    if (String(url).includes('/direction/transit')) return json(routing);
    if (String(url).includes('/assistant/inputtips')) return json(routing);
    throw new Error(`unexpected call: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function provider(): AmapTransitProvider {
  return new AmapTransitProvider(new DatabaseService(db as never));
}

const QUERY = { from: '31.310,120.628', to: '31.263,120.740', time: ANCHOR };

afterEach(() => {
  vi.unstubAllGlobals();
  mockAppSettings.mockReset();
  clearAmapTransitCache();
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe('AmapTransitProvider.isActive', () => {
  it('AMAP-100: answers only when the admin picked Amap AND a key resolves', () => {
    settings({ provider: 'transitous' });
    expect(provider().isActive(7)).toBe(false);

    // Picked, but nobody pasted a key: the search must quietly stay on
    // Transitous rather than 403 on every request.
    settings({ provider: 'amap', key: null });
    expect(provider().isActive(7)).toBe(false);

    settings({ provider: 'amap' });
    expect(provider().isActive(7)).toBe(true);
  });
});

// ── the datum ────────────────────────────────────────────────────────────────

describe('AmapTransitProvider datum handling', () => {
  it('AMAP-101: every stop coordinate leaves as WGS-84, never the GCJ-02 that arrived', async () => {
    settings();
    stubAmap(SUZHOU_METRO);
    const { itineraries } = await provider().plan(QUERY, 'zh', 7);

    const ride = itineraries[0]!.legs.find((leg) => leg.mode === 'SUBWAY')!;
    const expected = gcj02ToWgs84(31.308679, 120.630459);
    expect(ride.from.lat).toBeCloseTo(expected.lat, 9);
    expect(ride.from.lng).toBeCloseTo(expected.lng, 9);
    // The shift is the whole point — assert it actually moved, so a future
    // "simplification" that drops the conversion fails here rather than putting
    // every Chinese stop a few hundred metres up the road.
    expect(Math.abs(ride.from.lat - 31.308679)).toBeGreaterThan(1e-4);
  });

  it('AMAP-102: a leg polyline is re-encoded in WGS-84 at the precision it declares', async () => {
    settings();
    stubAmap(SUZHOU_METRO);
    const { itineraries } = await provider().plan(QUERY, 'zh', 7);

    const ride = itineraries[0]!.legs.find((leg) => leg.mode === 'SUBWAY')!;
    const points = decodePolyline(ride.geometry!, ride.geometryPrecision);
    expect(points).toHaveLength(3);
    const first = gcj02ToWgs84(31.308679, 120.630459);
    expect(points[0]![0]).toBeCloseTo(first.lat, 4);
    expect(points[0]![1]).toBeCloseTo(first.lng, 4);
  });

  it('AMAP-103: the request carries GCJ-02, because that is the datum Amap reads', async () => {
    settings();
    const fetchMock = stubAmap(SUZHOU_METRO);
    await provider().plan(QUERY, 'zh', 7);

    const routing = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/direction/transit'))!;
    const origin = new URL(routing).searchParams.get('origin')!;
    const [lng, lat] = origin.split(',').map(Number);
    // Round-tripping the sent coordinate back through the inverse lands on what
    // the caller asked for.
    const back = gcj02ToWgs84(lat!, lng!);
    expect(back.lat).toBeCloseTo(31.31, 4);
    expect(back.lng).toBeCloseTo(120.628, 4);
  });
});

// ── field mapping ────────────────────────────────────────────────────────────

describe('AmapTransitProvider field mapping', () => {
  it('AMAP-104: a metro ride becomes a SUBWAY leg with the line and direction split apart', async () => {
    settings();
    stubAmap(SUZHOU_METRO);
    const { itineraries } = await provider().plan(QUERY, 'zh', 7);

    expect(itineraries).toHaveLength(1);
    const legs = itineraries[0]!.legs;
    expect(legs.map((leg) => leg.mode)).toEqual(['WALK', 'SUBWAY', 'WALK', 'SUBWAY', 'WALK']);

    const first = legs[1]!;
    expect(first.line).toBe('轨道交通6号线');
    expect(first.headsign).toBe('桑田岛');
    expect(first.from.name).toBe('临顿路');
    expect(first.to.name).toBe('琼姬墩');
    expect(first.intermediateStops).toBe(5);
    expect(first.distance).toBe(9662);
    // Amap publishes no line colour, and an invented one would be confidently
    // wrong where null lets the client use the mode's own.
    expect(first.lineColor).toBeNull();
  });

  it('AMAP-105: parallel buslines on the same hop are one ride, not four', async () => {
    settings();
    stubAmap(PARALLEL_BUSES);
    const { itineraries } = await provider().plan(QUERY, 'zh', 7);

    const legs = itineraries[0]!.legs;
    expect(legs).toHaveLength(1);
    expect(legs[0]!.mode).toBe('BUS');
    expect(legs[0]!.line).toBe('9路');
    expect(itineraries[0]!.transfers).toBe(0);
  });

  it('AMAP-106: a walk takes its names from whatever it connects', async () => {
    settings();
    stubAmap(SUZHOU_METRO);
    const { itineraries } = await provider().plan(QUERY, 'zh', 7);

    const legs = itineraries[0]!.legs;
    // START/END are the tokens MOTIS uses for the journey's own ends, and both
    // the panel and the MCP builder swap the user's place names back in.
    expect(legs[0]!.from.name).toBe('START');
    expect(legs[0]!.to.name).toBe('临顿路');
    expect(legs[2]!.from.name).toBe('琼姬墩');
    expect(legs[4]!.to.name).toBe('END');
  });
});

// ── the derived clock ────────────────────────────────────────────────────────

describe('AmapTransitProvider derived times', () => {
  it('AMAP-107: the journey starts when the user asked and lasts what Amap said', async () => {
    settings();
    stubAmap(SUZHOU_METRO);
    const { itineraries } = await provider().plan(QUERY, 'zh', 7);

    const it = itineraries[0]!;
    expect(it.startTime).toBe(ANCHOR);
    expect(it.duration).toBe(2907);
    expect(new Date(it.endTime).getTime() - new Date(ANCHOR).getTime()).toBe(2907 * 1000);
    // Legs are contiguous and the last one ends exactly when the journey does —
    // a card that showed its final leg finishing before its own arrival time
    // would read as a bug in the itinerary rather than in the provider.
    expect(it.legs[0]!.from.time).toBe(ANCHOR);
    expect(it.legs[it.legs.length - 1]!.to.time).toBe(it.endTime);
    expect(it.walkSeconds).toBe(481 + 289 + 307);
  });

  it('AMAP-108: the wait Amap does not itemise lands in front of the first ride', async () => {
    settings();
    stubAmap(PARALLEL_BUSES);
    const { itineraries } = await provider().plan(QUERY, 'zh', 7);

    const it = itineraries[0]!;
    // 1200s reported, 900s of riding: the 300s difference is waiting for the
    // bus, so the ride starts five minutes after the journey does.
    expect(new Date(it.legs[0]!.from.time!).getTime() - new Date(ANCHOR).getTime()).toBe(300 * 1000);
    expect(it.duration).toBe(1200);
  });

  it('AMAP-109: arrive-by slides the journey back so it ends when asked', async () => {
    settings();
    stubAmap(SUZHOU_METRO);
    const { itineraries } = await provider().plan({ ...QUERY, arriveBy: true }, 'zh', 7);

    const it = itineraries[0]!;
    // Amap plans forwards only, so the toggle is honoured by moving the result
    // rather than by a parameter it does not have.
    expect(it.endTime).toBe(ANCHOR);
    expect(new Date(ANCHOR).getTime() - new Date(it.startTime).getTime()).toBe(2907 * 1000);
    expect(it.legs[0]!.from.time).toBe(it.startTime);
  });
});

// ── filters and failure ──────────────────────────────────────────────────────

describe('AmapTransitProvider filters and failures', () => {
  it('AMAP-110: a mode filter Amap cannot express is enforced on the answer', async () => {
    settings();
    stubAmap(PARALLEL_BUSES);
    // The picker's subway chip. Amap has no mode parameter at all, so a bus
    // itinerary has to be dropped here or the user gets what they filtered out.
    const { itineraries } = await provider().plan({ ...QUERY, modes: 'SUBWAY' }, 'zh', 7);
    expect(itineraries).toEqual([]);

    clearAmapTransitCache();
    stubAmap(SUZHOU_METRO);
    const metro = await provider().plan({ ...QUERY, modes: 'SUBWAY' }, 'zh', 7);
    expect(metro.itineraries).toHaveLength(1);
  });

  it('AMAP-111: a coordinate with no city yields nothing, and never a routing call', async () => {
    settings();
    const fetchMock = stubAmap(SUZHOU_METRO, REGEO_NOWHERE);
    const { itineraries } = await provider().plan(QUERY, 'zh', 7);

    expect(itineraries).toEqual([]);
    // city1/city2 are required; calling without them would spend a request to
    // be told MISSING_REQUIRED_PARAMS.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/direction/transit'))).toBe(false);
  });

  it('AMAP-112: Amap reports failure in a 200 body, and it still arrives as the right status', async () => {
    settings();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' })),
    );
    await expect(provider().plan(QUERY, 'zh', 7)).rejects.toMatchObject({ status: 403 });
  });

  it('AMAP-113: the picker gets stations, and region suggestions are not places to leave from', async () => {
    settings();
    stubAmap({
      status: '1',
      info: 'OK',
      infocode: '10000',
      tips: [
        { name: '观前街', district: '江苏省苏州市姑苏区', typecode: '061000', location: '120.625637,31.310624' },
        { name: '临顿路', district: '江苏省苏州市姑苏区', typecode: '150500', location: '120.630459,31.308679' },
        // Amap returns region matches in the same list, with no coordinate.
        { name: '苏州市', district: '江苏省', typecode: '190100', location: [] },
      ],
    });

    const { results } = await provider().geocode('观前街', 'zh', '31.310,120.628', 7);
    expect(results.map((r) => r.name)).toEqual(['观前街', '临顿路']);
    expect(results[1]!.type).toBe('STOP');
    expect(results[0]!.type).toBe('PLACE');
    expect(results[0]!.area).toBe('江苏省苏州市姑苏区');
    const wgs = gcj02ToWgs84(31.310624, 120.625637);
    expect(results[0]!.lat).toBeCloseTo(wgs.lat, 9);
  });
});

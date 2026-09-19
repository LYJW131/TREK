import { Injectable } from '@nestjs/common';
import { fromAmapLocation, toAmapLocation } from '@trek/shared';
import { readEnv } from '../../app-config';
import { DatabaseService } from '../database/database.service';
import { amapText, asArray, callAmap, type AmapEnvelope } from '../maps/providers/amap-client';
import { resolveApiKey, type ApiKeySource } from '../settings/instance-api-keys';
import { readTransitProvider } from './transit-provider';
import {
  deriveTransitStats,
  encodePolyline,
  type PlanQuery,
  type TransitItinerary,
  type TransitLeg,
  type TransitLegStop,
  type TransitPlace,
} from './transit.helpers';

/**
 * Amap (高德地图) as the transit backend, for mainland China.
 *
 * Transitous is built on public GTFS feeds and there are almost none for China:
 * a search between two Suzhou metro stations returns nothing at all, because
 * neither stop exists in any feed. Google is no better here — it is unreachable
 * from a Chinese network and its Chinese transit data is thin where it does
 * answer. Amap is what the metro actually publishes into.
 *
 * The key is the one the install already has (`amap_api_key`, the same operator
 * env → instance → caller's own row chain the Amap *places* provider uses), so
 * an install that already searches places with Amap gets transit for free.
 *
 * Three things make this provider unlike the other two:
 *
 *  1. **Datum.** Amap speaks GCJ-02 and TREK speaks WGS-84 everywhere else.
 *     This file is the third place in the codebase allowed to hold a GCJ-02
 *     coordinate (after maps/providers/amap.provider.ts and the client's
 *     gcj02Crs), and like them it never lets one escape: coordinates are
 *     converted on the way out and every stop, every polyline point on the way
 *     back. Nothing downstream — a reservation, the map, a GPX export — sees
 *     GCJ-02.
 *
 *  2. **No timetable.** This is the honest limitation and it shapes the whole
 *     mapping. Amap answers with durations, not departures: a busline carries
 *     `station_start_time`/`station_end_time` (the first and last service of
 *     the day) and nothing that says when *this* journey leaves. So the clock
 *     on an itinerary is derived — it starts at the time the user asked for and
 *     runs forward through the leg durations. For a metro on a five-minute
 *     headway that is close enough to plan a day around, but it is an estimate,
 *     and the client says so rather than presenting it as a departure board.
 *     `transit.estimatedTimes` in the results footer is that sentence.
 *
 *  3. **City codes.** `city1`/`city2` are required, and a coordinate does not
 *     carry one, so each endpoint is reverse-geocoded first. Both calls are
 *     cached hard (a district boundary does not move) and keyed on the rounded
 *     coordinate, so planning the same trip with different filters costs one
 *     routing call and no geocodes.
 */

const TRANSIT_PATH = '/v5/direction/transit/integrated';
const REGEO_PATH = '/v3/geocode/regeo';

/** We build these polylines ourselves from Amap's point list, so we pick the precision. */
const AMAP_POLYLINE_PRECISION = 5;

const ADCODE_TTL = 24 * 60 * 60 * 1000;
const GEOCODE_TTL = 30 * 60 * 1000;
const PLAN_TTL = 5 * 60 * 1000;
const CACHE_MAX = 200;

const cache = new Map<string, { at: number; ttl: number; data: unknown }>();

function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.data;
}

function cacheSet(key: string, ttl: number, data: unknown): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ttl, data });
}

/** Exposed for tests — the cache is module-scoped for the same reason the other two providers' are. */
export function clearAmapTransitCache(): void {
  cache.clear();
}

/**
 * Amap's vehicle wording → the mode tokens the client already has icons for.
 *
 * Matched on substrings because the field is prose, not an enum: the same
 * subway arrives as `地铁线路` in one city and `轨道交通` in another. Order
 * matters twice over — `有轨电车` (a tram) has to be tested before the bare
 * `电车`, which in Chinese transit wording is a trolleybus and therefore a bus,
 * and `机场巴士` before the bare `巴士`.
 */
const MODE_RULES: Array<[RegExp, string]> = [
  [/地铁|轨道交通|磁悬浮/, 'SUBWAY'],
  [/有轨电车|轻轨/, 'TRAM'],
  [/轮渡|渡轮|水上巴士/, 'FERRY'],
  [/索道|缆车/, 'AERIAL_LIFT'],
  [/机场巴士|城际|长途/, 'COACH'],
  [/火车|铁路|动车|高铁/, 'RAIL'],
];

/**
 * An unrecognised line becomes a BUS rather than being dropped.
 *
 * Amap invents wording per city and a mode token TREK does not know would be
 * rejected downstream by transitLegSchema, taking the whole itinerary with it.
 * A local shuttle shown as a bus is wrong in the icon and right in every other
 * way; a disappeared connection is wrong in the only way a user notices.
 */
function modeForBusline(type: string): string {
  for (const [pattern, mode] of MODE_RULES) if (pattern.test(type)) return mode;
  return 'BUS';
}

/**
 * `轨道交通6号线(苏州新区火车站--桑田岛)` → line `轨道交通6号线`, headsign `桑田岛`.
 *
 * Amap packs the direction into the line name as a `(起点--终点)` suffix. Split
 * apart, the two halves land where the rest of TREK already expects them: the
 * badge on the card shows the line, the row under it reads "towards 桑田岛".
 * Anything that does not match that shape is kept whole as the line name — a
 * clipped label is worse than a long one.
 */
function splitLineName(raw: string): { line: string; headsign: string | null } {
  const match = /^(.*?)[(（]([^)）]*)[)）]\s*$/.exec(raw.trim());
  if (!match) return { line: raw.trim() || '', headsign: null };
  const [, name = '', inner = ''] = match;
  const terminus = inner.split(/--|—|－|至/).pop()?.trim() || null;
  return { line: name.trim() || raw.trim(), headsign: terminus };
}

/** `120.63,31.30;120.64,31.31` (GCJ-02) → an encoded polyline in WGS-84, or null. */
function toWgsPolyline(raw: unknown): string | null {
  const text = amapText(raw);
  if (!text) return null;
  const points: [number, number][] = [];
  for (const pair of text.split(';')) {
    const wgs = fromAmapLocation(pair);
    if (wgs) points.push([wgs.lat, wgs.lng]);
  }
  return points.length > 1 ? encodePolyline(points, AMAP_POLYLINE_PRECISION) : null;
}

function stopAt(name: string, location: unknown): TransitLegStop {
  const wgs = fromAmapLocation(location);
  return {
    name,
    // 0 rather than null for a missing coordinate, for the reason mapStop() in
    // transit.service.ts gives: TransitLegStop.lat/lng are non-nullable across
    // the wire contract, and making them nullable would ripple out into the
    // itinerary validator and start dropping usable results.
    lat: wgs?.lat ?? 0,
    lng: wgs?.lng ?? 0,
    time: null,
    scheduledTime: null,
    // Amap has no platform/track field. Left null rather than guessed from the
    // station entrance it does give (`悬临通道4号口` is a way in, not a platform).
    track: null,
  };
}

function seconds(value: unknown): number {
  const n = Number.parseInt(amapText(value), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function metres(value: unknown): number | null {
  const n = Number.parseInt(amapText(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function shiftIso(iso: string, secondsToAdd: number): string {
  return new Date(new Date(iso).getTime() + secondsToAdd * 1000).toISOString();
}

interface AmapWalking {
  origin?: unknown;
  destination?: unknown;
  distance?: unknown;
  cost?: { duration?: unknown };
  steps?: Array<{ polyline?: { polyline?: unknown } }>;
}

interface AmapBusline {
  departure_stop?: { name?: unknown; location?: unknown };
  arrival_stop?: { name?: unknown; location?: unknown };
  name?: unknown;
  type?: unknown;
  distance?: unknown;
  cost?: { duration?: unknown };
  polyline?: { polyline?: unknown };
  via_stops?: unknown[];
}

interface AmapRailway {
  name?: unknown;
  trip?: unknown;
  time?: unknown;
  distance?: unknown;
  departure_stop?: { name?: unknown; location?: unknown; time?: unknown };
  arrival_stop?: { name?: unknown; location?: unknown; time?: unknown };
  via_stop?: unknown[];
}

interface AmapSegment {
  walking?: AmapWalking;
  bus?: { buslines?: AmapBusline[] };
  railway?: AmapRailway;
}

interface AmapTransit {
  cost?: { duration?: unknown };
  segments?: AmapSegment[];
}

interface AmapTransitResponse extends AmapEnvelope {
  route?: { transits?: AmapTransit[] };
}

interface AmapRegeoResponse extends AmapEnvelope {
  regeocode?: { addressComponent?: { citycode?: unknown; adcode?: unknown } };
}

interface AmapTipsResponse extends AmapEnvelope {
  tips?: Array<{ name?: unknown; district?: unknown; location?: unknown; typecode?: unknown }>;
}

/**
 * Amap POI type codes for the two things a transit picker is usually after.
 * 1505xx is a metro station, 1507xx a bus stop; everything else is a place, and
 * the picker renders the two differently.
 */
const STOP_TYPECODE = /^(1505|1507)/;

@Injectable()
export class AmapTransitProvider {
  constructor(private readonly database: DatabaseService) {}

  private resolveKey(userId: number): { key: string | null; source: ApiKeySource | null } {
    return resolveApiKey(this.database, 'amap_api_key', userId, readEnv().maps.amapApiKey);
  }

  /**
   * True only when the admin picked Amap AND a key actually resolves for this
   * caller — the same gate GoogleTransitProvider uses, for the same reason:
   * flipping the switch before pasting a key should quietly keep Transitous
   * answering rather than 403 every search on the instance.
   */
  isActive(userId: number): boolean {
    if (readTransitProvider(this.database) !== 'amap') return false;
    return !!this.resolveKey(userId).key;
  }

  private credential(userId: number): { key: string; source: ApiKeySource | null; userId: number } {
    const { key, source } = this.resolveKey(userId);
    if (!key) {
      const err = new Error('Transit provider error (no Amap API key configured)') as Error & { status: number };
      err.status = 502;
      throw err;
    }
    return { key, source, userId };
  }

  /**
   * The city code `city1`/`city2` require, from a coordinate that does not
   * carry one.
   *
   * Keyed on three decimals — about 100 m, far below the size of any city — so
   * a user nudging a pin does not buy a second geocode. `citycode` first
   * because it is the city proper (`0512`); `adcode` is the district beneath it
   * (`320508`) and Amap accepts either, but the city is the thing being asked
   * about.
   */
  private async cityCode(lat: number, lng: number, userId: number): Promise<string | null> {
    const key = `amap:adcode:${lat.toFixed(3)},${lng.toFixed(3)}`;
    const cached = cacheGet(key);
    if (cached !== null) return cached as string | null;

    const data = await callAmap<AmapRegeoResponse>(
      REGEO_PATH,
      { location: toAmapLocation(lat, lng), extensions: 'base' },
      'geocode/regeo',
      this.credential(userId),
      'Transit',
    );
    const component = data.regeocode?.addressComponent ?? {};
    const code = amapText(component.citycode) || amapText(component.adcode) || null;
    cacheSet(key, ADCODE_TTL, code);
    return code;
  }

  /**
   * Station/place search for the from/to pickers. `near` biases results.
   *
   * `language` is taken and ignored, which is worth stating rather than
   * dropping from the signature: neither 输入提示 nor the transit endpoint has a
   * language parameter, and both answer in Chinese. Keeping the argument holds
   * this provider to the same shape as the other two, so TransitService
   * dispatches to all three identically.
   */
  async geocode(
    text: string,
    _language: string | undefined,
    near: string | undefined,
    userId: number,
  ): Promise<{ results: TransitPlace[] }> {
    const cacheKey = `amap:geo:${text}|${near ?? ''}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached as { results: TransitPlace[] };

    const params: Record<string, string> = { keywords: text, datatype: 'all' };
    if (near) {
      const [lat = 0, lng = 0] = near.split(',').map(Number);
      params.location = toAmapLocation(lat, lng);
    }

    const data = await callAmap<AmapTipsResponse>(
      '/v3/assistant/inputtips',
      params,
      'assistant/inputtips',
      this.credential(userId),
      'Transit',
    );

    const results: TransitPlace[] = asArray(data.tips)
      .flatMap((tip) => {
        // A tip with no location is a region suggestion ("苏州市"), not somewhere
        // a journey can start; Amap returns those in the same list.
        const wgs = fromAmapLocation(tip.location);
        const name = amapText(tip.name);
        if (!wgs || !name) return [];
        const typecode = amapText(tip.typecode);
        return [
          {
            name,
            lat: wgs.lat,
            lng: wgs.lng,
            type: STOP_TYPECODE.test(typecode) ? 'STOP' : 'PLACE',
            area: amapText(tip.district) || null,
          },
        ];
      })
      .slice(0, 8);

    const payload = { results };
    cacheSet(cacheKey, GEOCODE_TTL, payload);
    return payload;
  }

  /** Route search between two coordinates. Returns the same compact shape MOTIS is mapped to. */
  async plan(q: PlanQuery, _language: string | undefined, userId: number): Promise<{ itineraries: TransitItinerary[] }> {
    const [fromLat = 0, fromLng = 0] = q.from.split(',').map(Number);
    const [toLat = 0, toLng = 0] = q.to.split(',').map(Number);

    const requested = (q.modes || '')
      .split(',')
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean)
      .filter((m) => m !== 'TRANSIT');

    // The clock the whole itinerary hangs off. Amap gives durations only, so
    // this is the anchor rather than a departure it reported — see the note at
    // the top of the file.
    const anchor = q.time ? new Date(q.time) : new Date();
    const anchorIso = anchor.toISOString();

    const [city1, city2] = await Promise.all([
      this.cityCode(fromLat, fromLng, userId),
      this.cityCode(toLat, toLng, userId),
    ]);
    if (!city1 || !city2) {
      // Outside Amap's coverage the reverse geocode comes back without a city,
      // and the routing call would fail with MISSING_REQUIRED_PARAMS. An empty
      // result is the truthful answer, and the client already names the backend
      // that produced it.
      return { itineraries: [] };
    }

    const params: Record<string, string> = {
      origin: toAmapLocation(fromLat, fromLng),
      destination: toAmapLocation(toLat, toLng),
      city1,
      city2,
      show_fields: 'cost,navi,polyline',
      // Amap's `date`/`time` are its own local wall clock for the city being
      // routed in, which for a China-only provider is always UTC+8.
      ...amapDateTime(anchor),
    };

    const cacheKey = `amap:plan:${JSON.stringify(params)}`;
    let data = cacheGet(cacheKey) as AmapTransitResponse | null;
    if (!data) {
      data = await callAmap<AmapTransitResponse>(
        TRANSIT_PATH,
        params,
        'direction/transit',
        this.credential(userId),
        'Transit',
      );
      cacheSet(cacheKey, PLAN_TTL, data);
    }

    const itineraries = asArray(data.route?.transits)
      .flatMap((transit) => {
        const built = buildItinerary(transit, anchorIso);
        return built ? [built] : [];
      })
      // Amap has no mode or transfer parameter, so both filters are applied to
      // the answer. A user who asked for the metro is held to it here rather
      // than being handed a bus — the same response-side enforcement the Google
      // provider does for the modes its request cannot express.
      .filter((it) => matchesRequestedModes(it, requested))
      .filter((it) => q.maxTransfers === undefined || q.maxTransfers === null || it.transfers <= q.maxTransfers)
      .map((it) => (q.arriveBy ? shiftToArriveBy(it, anchorIso) : it))
      .slice(0, 8);

    return { itineraries };
  }
}

/**
 * Amap's `date`/`time` pair, in the timezone it answers in.
 *
 * The parameters are documented as the departure moment and are read as local
 * time in the city being routed — and Amap only routes inside China, so that is
 * always UTC+8. Formatting the UTC instant in `Asia/Shanghai` is what makes a
 * 09:00 departure the user typed arrive as a 09:00 departure Amap plans for,
 * whatever the server's own zone is.
 */
function amapDateTime(at: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

/** One Amap `transit` → one TREK itinerary, or null when nothing in it is scheduled transit. */
function buildItinerary(transit: AmapTransit, anchorIso: string): TransitItinerary | null {
  const legs: TransitLeg[] = [];

  for (const segment of asArray(transit.segments)) {
    const walk = segment.walking;
    if (walk && seconds(walk.cost?.duration) > 0) legs.push(walkLeg(walk));

    const busline = asArray(segment.bus?.buslines)[0];
    // Amap returns every line serving the same pair of stops as parallel
    // entries — four bus routes that all get you from 市一中 to 烽火路北. The
    // first is the one its own app shows as the connection; the rest are the
    // same hop by a different number, and listing them as separate legs would
    // read as four rides in a row.
    if (busline) legs.push(busLeg(busline));
    else if (segment.railway) {
      const rail = railLeg(segment.railway);
      if (rail) legs.push(rail);
    }
  }

  if (!legs.some((leg) => leg.mode !== 'WALK')) return null;

  // Amap's total is longer than its parts: `cost.duration` counts the wait for
  // the first vehicle, which no segment carries. Putting that difference in
  // front of the first ride — rather than stretching a leg or leaving the
  // journey's end floating past its last leg — is what the wait actually is.
  const legTotal = legs.reduce((total, leg) => total + leg.duration, 0);
  const reported = seconds(transit.cost?.duration);
  const slack = Math.max(0, reported - legTotal);
  const endTime = shiftIso(anchorIso, Math.max(reported, legTotal));

  let cursor = anchorIso;
  let waitApplied = false;
  for (const leg of legs) {
    if (leg.mode !== 'WALK' && !waitApplied) {
      cursor = shiftIso(cursor, slack);
      waitApplied = true;
    }
    leg.from.time = cursor;
    leg.from.scheduledTime = cursor;
    cursor = shiftIso(cursor, leg.duration);
    leg.to.time = cursor;
    leg.to.scheduledTime = cursor;
  }

  nameWalkEndpoints(legs);

  return {
    startTime: anchorIso,
    endTime,
    ...deriveTransitStats(anchorIso, endTime, legs),
    legs,
  };
}

function walkLeg(walk: AmapWalking): TransitLeg {
  const points: [number, number][] = [];
  for (const step of asArray(walk.steps)) {
    for (const pair of amapText(step.polyline?.polyline).split(';')) {
      const wgs = fromAmapLocation(pair);
      if (!wgs) continue;
      const last = points[points.length - 1];
      // Consecutive steps repeat the point where one ends and the next begins.
      if (last && last[0] === wgs.lat && last[1] === wgs.lng) continue;
      points.push([wgs.lat, wgs.lng]);
    }
  }
  return {
    mode: 'WALK',
    // Named by nameWalkEndpoints() from whatever the walk connects to.
    from: stopAt('', walk.origin),
    to: stopAt('', walk.destination),
    duration: seconds(walk.cost?.duration),
    distance: metres(walk.distance),
    headsign: null,
    line: null,
    lineColor: null,
    lineTextColor: null,
    agency: null,
    intermediateStops: 0,
    geometry: points.length > 1 ? encodePolyline(points, AMAP_POLYLINE_PRECISION) : null,
    geometryPrecision: AMAP_POLYLINE_PRECISION,
  };
}

function busLeg(busline: AmapBusline): TransitLeg {
  const raw = amapText(busline.name);
  const { line, headsign } = splitLineName(raw);
  return {
    mode: modeForBusline(amapText(busline.type)),
    from: stopAt(amapText(busline.departure_stop?.name), busline.departure_stop?.location),
    to: stopAt(amapText(busline.arrival_stop?.name), busline.arrival_stop?.location),
    duration: seconds(busline.cost?.duration),
    distance: metres(busline.distance),
    headsign,
    line,
    // Amap publishes no line colour through the Web Service API. Null rather
    // than a guessed palette: the client falls back to the mode's own colour,
    // which is right, where an invented one would be confidently wrong.
    lineColor: null,
    lineTextColor: null,
    agency: null,
    intermediateStops: asArray(busline.via_stops).length,
    geometry: toWgsPolyline(busline.polyline?.polyline),
    geometryPrecision: AMAP_POLYLINE_PRECISION,
  };
}

/**
 * An intercity train segment.
 *
 * Written from Amap's documented shape rather than an observed response: every
 * pair tested so far answered with metro and bus only, and `railway` appears in
 * the schema for cross-province journeys. It is mapped defensively — a segment
 * missing the name or either stop returns null and is skipped, which costs one
 * leg of an itinerary rather than inventing one.
 */
function railLeg(railway: AmapRailway): TransitLeg | null {
  const name = amapText(railway.trip) || amapText(railway.name);
  const fromName = amapText(railway.departure_stop?.name);
  const toName = amapText(railway.arrival_stop?.name);
  if (!name || !fromName || !toName) return null;
  return {
    mode: 'RAIL',
    from: stopAt(fromName, railway.departure_stop?.location),
    to: stopAt(toName, railway.arrival_stop?.location),
    duration: seconds(railway.time),
    distance: metres(railway.distance),
    headsign: null,
    line: name,
    lineColor: null,
    lineTextColor: null,
    agency: null,
    intermediateStops: asArray(railway.via_stop).length,
    // Amap carries no geometry for a railway segment; the map draws the leg as
    // a straight line between its two stations, which is what it does for any
    // leg without a polyline.
    geometry: null,
    geometryPrecision: AMAP_POLYLINE_PRECISION,
  };
}

/**
 * A walk's two ends take the names of whatever they touch.
 *
 * Amap gives a walking segment two coordinates and no names at all, and the
 * journey's own endpoints are the coordinates the user searched from. START and
 * END are the tokens MOTIS uses for those, and both the web client and the MCP
 * itinerary builder already swap the user's chosen place names back in — so
 * matching that spelling is what makes an Amap walk read "Walk to 临顿路" like
 * every other one.
 */
function nameWalkEndpoints(legs: TransitLeg[]): void {
  for (let i = 1; i < legs.length; i++) {
    const leg = legs[i];
    if (leg && !leg.from.name) leg.from.name = legs[i - 1]?.to.name ?? '';
  }
  for (let i = legs.length - 2; i >= 0; i--) {
    const leg = legs[i];
    if (leg && !leg.to.name) leg.to.name = legs[i + 1]?.from.name ?? '';
  }
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (first && !first.from.name) first.from.name = 'START';
  if (last && !last.to.name) last.to.name = 'END';
  for (const leg of legs) {
    // transitStopSchema wants a non-empty name; a walk between two unnamed
    // points has nothing better to be called.
    if (!leg.from.name) leg.from.name = 'Transfer';
    if (!leg.to.name) leg.to.name = 'Transfer';
  }
}

/**
 * Amap plans forwards only — there is no arrive-by parameter.
 *
 * Rather than dropping the toggle, the journey is planned from the requested
 * moment and then slid back so it *ends* there. The duration is the one Amap
 * gave for a departure at that time of day, which for anything on a headway is
 * the same journey; it stops being exact across a service-frequency boundary,
 * and that is the same estimate the whole provider already is.
 */
function shiftToArriveBy(itinerary: TransitItinerary, arriveIso: string): TransitItinerary {
  const delta = Math.round((new Date(arriveIso).getTime() - new Date(itinerary.endTime).getTime()) / 1000);
  if (delta === 0) return itinerary;
  const move = (stop: TransitLegStop): TransitLegStop => ({
    ...stop,
    time: stop.time ? shiftIso(stop.time, delta) : null,
    scheduledTime: stop.scheduledTime ? shiftIso(stop.scheduledTime, delta) : null,
  });
  return {
    ...itinerary,
    startTime: shiftIso(itinerary.startTime, delta),
    endTime: arriveIso,
    legs: itinerary.legs.map((leg) => ({ ...leg, from: move(leg.from), to: move(leg.to) })),
  };
}

/** The response-side half of the mode filter — Amap's request has no equivalent at all. */
function matchesRequestedModes(itinerary: TransitItinerary, requested: string[]): boolean {
  if (requested.length === 0) return true;
  const wanted = new Set(requested);
  return itinerary.legs.every((leg) => leg.mode === 'WALK' || wanted.has(leg.mode));
}

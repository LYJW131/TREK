/**
 * The outbound half of every Amap (高德) Web Service call.
 *
 * Lifted out of AmapPlacesProvider when the transit backend became the second
 * caller. Nothing in here is Places-specific — the signature scheme, the
 * response cap, and the one part that must not be written twice: the
 * translation of Amap's body-carried verdict into the `Error & { status }` the
 * controllers map.
 *
 * That last one is why this file exists rather than a second copy of the same
 * forty lines. Amap answers HTTP 200 for a dead key, an exhausted quota and a
 * real result alike, with the difference only in `status`/`infocode`. A second
 * implementation of that check is a second chance to report a credential
 * failure to the user as "no connections found".
 */
import { createHash } from 'node:crypto';
import { readEnv } from '../../../app-config';
import { safeFetchFollow } from '../../../utils/ssrfGuard';
import { discardBody, exceedsDeclaredLength, readCappedJson } from '../../../utils/cappedFetch';
import { UA } from '../maps.helpers';
import type { ApiKeySource } from '../../settings/instance-api-keys';

/** The upstream every Web Service call is written against. */
export const AMAP_UPSTREAM = 'https://restapi.amap.com';

/** A search answer is a few dozen POIs; anything past this is not the endpoint we think it is. */
export const AMAP_MAX_RESPONSE_BYTES = 1_000_000;

export interface AmapEnvelope {
  status?: string;
  info?: string;
  infocode?: string;
}

/** Who the call is made on behalf of — the key, and enough to make a failure traceable. */
export interface AmapCredential {
  key: string;
  source: ApiKeySource | null;
  /** Whose request this is; 0 for an unauthenticated read. */
  userId: number;
}

/** An Amap list field, or nothing. The envelope is checked; its arrays never were. */
export function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Amap returns an empty *array* where a string field has no value — `address:
 * []`, `tel: []` — so every optional text field has to be coerced rather than
 * read. A bare `poi.address || ''` yields `[]` in a template and `"[]"` in the
 * database.
 */
export function amapText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  // Some fields arrive as a one-element array of the value.
  if (Array.isArray(value) && value.length === 1) return amapText(value[0]);
  return '';
}

export function amapNumber(value: unknown): number | null {
  const text = amapText(value);
  if (!text) return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Amap's own error text for the codes an operator can actually act on.
 *
 * The raw `info` string is returned for everything else; these three are
 * singled out because they are the ones a misconfigured install hits first, and
 * because Amap's own wording for them ("INVALID_USER_SCODE") does not tell an
 * admin what to change.
 */
const AMAP_INFOCODE_HINTS: Record<string, string> = {
  '10001': 'Amap API key is invalid — check that it is a "Web 服务" (web service) key, not a JS API key',
  '10003': 'Amap daily request quota exhausted',
  '10009': 'Amap key rejected the request: the key is restricted to a different domain or IP',
};

/**
 * The HTTP status TREK should answer with for an Amap failure.
 *
 * Amap's own status line is always 200, and the controller maps a thrown
 * `.status` straight through to the client, so a credential problem has to
 * arrive as 403 and a quota problem as 429 for the client to say anything
 * useful about it.
 */
export function statusForInfocode(infocode: string): number {
  if (infocode === '10001' || infocode === '10009') return 403;
  if (infocode === '10003' || infocode === '10004' || infocode === '10019' || infocode === '10020') return 429;
  return 502;
}

let amapApiCallCount = 0;

/**
 * Amap's optional 数字签名 (digital signature).
 *
 * A key can be created with a private secret, and such a key rejects every
 * unsigned request. The scheme is an MD5 over every query parameter sorted by
 * name, the key and the output format included, with the secret appended.
 * MD5 because Amap specifies MD5, not because anything here is choosing a
 * hash.
 *
 * Unset, which is the common case, nothing is added.
 */
function signature(params: Record<string, string>, key: string): string | null {
  const secret = readEnv().maps.amapApiSecret;
  if (!secret) return null;
  const signed = { ...params, key, output: 'JSON' };
  const canonical = Object.keys(signed)
    // Byte order, and it has to stay byte order: Amap computes the same signature over
    // the same sorted names, so a locale-aware comparison would produce a signature the
    // other side rejects.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${signed[k]}`)
    .join('&');
  return createHash('md5').update(`${canonical}${secret}`).digest('hex');
}

/**
 * Build the full URL for one call, key and optional signature attached.
 *
 * `AMAP_API_BASE` mirrors `PLACES_API_BASE`: an install that routes its
 * outbound calls through a proxy or a gateway holding the credential says so
 * once, here.
 */
export function amapUrl(path: string, params: Record<string, string>, key: string): string {
  const query = new URLSearchParams({ ...params, key, output: 'JSON' });
  const sig = signature(params, key);
  if (sig) query.set('sig', sig);
  const base = (readEnv().maps.amapApiBase || AMAP_UPSTREAM).replace(/([^/]|^)\/+$/, '$1');
  return `${base}${path}?${query.toString()}`;
}

/** The thrower both the places and the transit caller use, so one failure reads the same in both logs. */
export function amapFail(domain: string, label: string, credential: AmapCredential, status: number, message: string): never {
  console.error(`[${domain}] amap/${label} failed with ${status} userId=${credential.userId} keySource=${credential.source}`);
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  throw err;
}

/**
 * One call, with the body-carried verdict turned into a real error.
 *
 * Through safeFetchFollow like every other outbound URL in the maps domain, so
 * a proxied base cannot be pointed at something internal.
 */
export async function callAmap<T extends AmapEnvelope>(
  path: string,
  params: Record<string, string>,
  label: string,
  credential: AmapCredential,
  domain = 'Maps',
): Promise<T> {
  const url = amapUrl(path, params, credential.key);
  amapApiCallCount++;
  // The key rides in the query string, so the label is logged without the URL —
  // unlike the Google path, where the credential sits in a header.
  console.debug(`[Amap API] #${amapApiCallCount} ${label} → ${path}`);

  const response = await safeFetchFollow(
    url,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) },
    { bypassInternalIpAllowed: true },
  );

  if (!response.ok) {
    // A transport-level failure, i.e. the proxy in front of Amap rather than
    // Amap itself: Amap's own answers are always 200.
    amapFail(domain, label, credential, response.status, `Amap ${label} failed with HTTP ${response.status}`);
  }

  // Capped, like the places index client next door: the base URL is
  // configurable (AMAP_API_BASE points at an operator's own gateway), and an
  // answer of arbitrary size was buffered into the heap in full before
  // anything looked at it.
  if (exceedsDeclaredLength(response, AMAP_MAX_RESPONSE_BYTES)) {
    discardBody(response);
    amapFail(domain, label, credential, 502, `Amap ${label} answered with more than ${AMAP_MAX_RESPONSE_BYTES} bytes`);
  }
  const data = await readCappedJson<T>(response, AMAP_MAX_RESPONSE_BYTES);
  if (!data || typeof data !== 'object') {
    amapFail(domain, label, credential, 502, `Amap ${label} answered with something that is not a JSON object`);
  }
  if (data.status !== '1') {
    const infocode = data.infocode ?? '';
    const hint = AMAP_INFOCODE_HINTS[infocode] || data.info || 'Amap API error';
    amapFail(domain, label, credential, statusForInfocode(infocode), `${hint} (infocode ${infocode || 'none'})`);
  }
  return data;
}

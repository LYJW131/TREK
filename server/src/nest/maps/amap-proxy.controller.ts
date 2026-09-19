import { Controller, Get, HttpException, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { readEnv } from '../../app-config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { safeFetchFollow } from '../../utils/ssrfGuard';

/**
 * The `/_AMapService` prefix Amap's JS API is pointed at, so its 安全密钥 never
 * reaches a browser.
 *
 * Amap documents two ways to supply that secret. The easy one writes it into
 * the page beside the SDK script, and their own documentation says of it:
 * 「不建议在生产环境使用（不安全）」 — anybody who views source has the
 * operator's credential, and the domain allow-list on the key is the only thing
 * left standing between them and the quota. The other way is this: the browser
 * is told `serviceHost: <origin>/_AMapService`, and whatever the SDK asks for
 * there is forwarded with `jscode` appended server-side.
 *
 * `_AMapService` is Amap's fixed prefix — it is not a name TREK chose and it
 * cannot be changed, which is why this controller sits outside the `api/`
 * namespace every other one uses.
 *
 * **What actually comes through here is one call**, measured against the real
 * SDK rather than assumed: `/v3/log/init`. It looks like telemetry and is not —
 * it is the authorisation round-trip, and a map whose copy of it fails renders
 * nothing at all while reporting no error the app can catch. The vector tiles,
 * the styles and the icon sheets go straight to Amap without the secret. The
 * `/v4/map/styles` branch below is for a custom basemap style, which TREK does
 * not use yet and which the docs put on a different host; it is here because
 * the split is Amap's, not because something asks for it today.
 *
 * Authenticated, because the secret is: the SDK loads this through a `<script>`
 * tag from the app's own origin, so the session cookie rides along and the
 * guard sees it. An unauthenticated version of this route would be an open
 * relay onto the operator's Amap quota.
 */

/** Amap's own split: custom map styles on one host, every Web 服务 call on the other. */
const STYLES_PREFIX = '/v4/map/styles';
const STYLES_UPSTREAM = 'https://webapi.amap.com';
const SERVICE_UPSTREAM = 'https://restapi.amap.com';

/**
 * Only Amap's versioned API paths are forwarded.
 *
 * The documented Nginx example forwards everything under the prefix. This is
 * narrower on purpose: the handler holds a credential, and the set of things
 * the SDK asks for is `/v3/…`-shaped. Anything else is a request this proxy was
 * not built for, and answering it with the operator's key attached is how a
 * convenience becomes a relay.
 */
const FORWARDABLE = /^\/v\d+\/[A-Za-z0-9._\-/]*$/;

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const RL_WINDOW = 60_000;

@Controller('_AMapService')
@UseGuards(JwtAuthGuard)
export class AmapProxyController {
  constructor(private readonly rl: RateLimitService) {}

  @Get('*path')
  async forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.rl.check('amap_service', req.ip || 'unknown', 600, RL_WINDOW, Date.now())) {
      throw new HttpException({ error: 'Too many requests. Please try again later.' }, 429);
    }

    const secret = readEnv().maps.amapJsSecurityCode;
    if (!secret) {
      // Explicit, because the alternative is forwarding without `jscode` and
      // handing the user a blank map with a 200 behind it.
      throw new HttpException({ error: 'Amap JS API security code is not configured' }, 503);
    }

    const raw = (req.params as Record<string, unknown>).path ?? '';
    const sub = '/' + (Array.isArray(raw) ? raw.join('/') : String(raw)).replace(/^\/+/, '');
    if (sub.includes('..') || !FORWARDABLE.test(sub)) {
      throw new HttpException({ error: 'Not found' }, 404);
    }

    const base = sub.startsWith(STYLES_PREFIX) ? STYLES_UPSTREAM : SERVICE_UPSTREAM;
    // The query is taken off the original URL rather than rebuilt from req.query:
    // Amap's JSONP callback name and its repeated parameters have to arrive
    // byte-for-byte, and a re-serialised object does not promise that.
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
    const url = `${base}${sub}?${query}${query ? '&' : ''}jscode=${encodeURIComponent(secret)}`;

    let upstream: Awaited<ReturnType<typeof safeFetchFollow>>;
    try {
      upstream = await safeFetchFollow(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new HttpException({ error: 'Amap service is unreachable' }, 502);
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new HttpException({ error: 'Amap service answered with too much' }, 502);
    }

    // Deliberately not a header passthrough. Amap sets `acw_tc`/`cdn_sec_tc`
    // cookies on its own answers, and this route is same-origin with the app —
    // forwarding Set-Cookie would write a third party's cookies onto the
    // session's own domain.
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-store');
    res.status(upstream.status).send(body);
  }
}

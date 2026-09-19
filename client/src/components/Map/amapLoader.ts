/**
 * Loads the Amap (高德) JS API 2.0 into the page, once.
 *
 * The SDK is a script tag, not an npm package: the loader package Amap ships is
 * a thin wrapper around exactly this, and a bundled copy would pull a megabyte
 * into every chunk that draws a map — the same reason the MapLibre engine is
 * imported dynamically next door.
 *
 * Two things about this SDK are not like the others:
 *
 *  - **The key is a different key.** `AMAP_API_KEY` on the server is a
 *    「Web 服务」key and the JS API refuses it. This one has to be created as
 *    「Web端(JS API)」, and since 2021 every key has a 安全密钥 beside it. That
 *    second one does NOT ship here: Amap's own documentation calls writing it
 *    into the page 「不建议在生产环境使用（不安全）」, so the SDK is pointed at
 *    `/_AMapService` instead and the server appends it (AmapProxyController).
 *    The pointer has to be set BEFORE the script runs; set afterwards it is
 *    ignored in silence and the map stays blank with nothing to catch.
 *  - **It is a credential that belongs in the browser.** Unlike the Web 服务 key
 *    this one is public by design — it ships in the page. Amap's protection is
 *    the domain allow-list on the key itself, which is the operator's to set.
 */

/** The global the SDK installs. Only the handful of members this app touches. */
export interface AmapGlobal {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AmapMap;
}

export interface AmapMap {
  setZoomAndCenter(zoom: number, center: [number, number], immediately?: boolean): void;
  setMapStyle(style: string): void;
  getZoom(digits?: number): number;
  getCenter(): { lng: number; lat: number };
  getSize?(): { width: number; height: number };
  destroy(): void;
  // Amap hands its own event object to the handler; the shapes this app reads
  // are declared at the call site rather than here, because the SDK's own types
  // are not published for the `<script>` build.
  on(event: string, handler: (e: never) => void): void;
  off(event: string, handler: (e: never) => void): void;
}

declare global {
  interface Window {
    AMap?: AmapGlobal;
    _AMapSecurityConfig?: { serviceHost?: string; securityJsCode?: string };
  }
}

/**
 * Amap's fixed prefix for the proxy that holds the 安全密钥.
 *
 * Not a name TREK picked and not one it may change — the SDK asks here and
 * nowhere else. Server side it is AmapProxyController.
 */
const SERVICE_PREFIX = '/_AMapService';

const SDK_VERSION = '2.0';
const SDK_ORIGIN = 'https://webapi.amap.com';

/**
 * One load per page, keyed on the key.
 *
 * A second `<script src=…maps?key=…>` re-runs the whole SDK and leaves two
 * copies of its globals; the promise is memoised so a second map — or a
 * remount — waits on the first load instead of starting another.
 */
let pending: { key: string; promise: Promise<AmapGlobal> } | null = null;

export function loadAmapSdk(key: string): Promise<AmapGlobal> {
  if (!key) return Promise.reject(new Error('no Amap JS API key configured'));
  if (pending?.key === key) return pending.promise;
  if (window.AMap) return Promise.resolve(window.AMap);

  const promise = new Promise<AmapGlobal>((resolve, reject) => {
    // Before the script, always: the SDK reads this global while it initialises,
    // and a value set afterwards is silently ignored.
    window._AMapSecurityConfig = { serviceHost: `${window.location.origin}${SERVICE_PREFIX}` };

    const script = document.createElement('script');
    script.src = `${SDK_ORIGIN}/maps?v=${SDK_VERSION}&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.onload = () => {
      if (window.AMap) resolve(window.AMap);
      // A rejected key still loads the script — the SDK just never installs its
      // global. Without this branch the caller waits forever on a blank div.
      else reject(new Error('the Amap SDK loaded but installed no global — check the key type and its domain allow-list'));
    };
    script.onerror = () => reject(new Error('the Amap SDK script did not load'));
    document.head.appendChild(script);
  });

  pending = { key, promise };
  // A failed load must not be cached: the user pasting a correct key next is the
  // normal recovery, and a memoised rejection would outlive it.
  promise.catch(() => {
    if (pending?.key === key) pending = null;
  });
  return promise;
}

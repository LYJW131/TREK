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
 *    「Web端(JS API)」, and since 2021 it also needs a 安全密钥 (`securityJsCode`)
 *    set on `window._AMapSecurityConfig` BEFORE the script runs. Set it after and
 *    every request the map makes comes back INVALID_USER_SCODE, with a map that
 *    simply stays blank.
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
  getZoom(): number;
  getCenter(): { lng: number; lat: number };
  destroy(): void;
  on(event: string, handler: () => void): void;
}

declare global {
  interface Window {
    AMap?: AmapGlobal;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

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

export function loadAmapSdk(key: string, securityCode?: string): Promise<AmapGlobal> {
  if (!key) return Promise.reject(new Error('no Amap JS API key configured'));
  if (pending?.key === key) return pending.promise;
  if (window.AMap) return Promise.resolve(window.AMap);

  const promise = new Promise<AmapGlobal>((resolve, reject) => {
    // Before the script, always: the SDK reads this global while it initialises.
    if (securityCode) window._AMapSecurityConfig = { securityJsCode: securityCode };

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

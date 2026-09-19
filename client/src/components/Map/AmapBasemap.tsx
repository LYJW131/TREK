import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import type L from 'leaflet'
import { wgs84ToGcj02 } from '@trek/shared'
import { useIsDark } from '../../hooks/useIsDark'
import { useSettingsStore } from '../../store/settingsStore'
import { loadAmapSdk, type AmapMap } from './amapLoader'

/**
 * The backdrop's own style, and `pointer-events: none` is the load-bearing part.
 *
 * Without it the topmost element under a finger is Amap's `<canvas class="amap-layer">`,
 * because a positioned child paints above the container it sits in. Leaflet sets
 * `touch-action: none` on ITS container so it can own gestures; the canvas carries
 * `touch-action: auto`, so on a touch device the browser applied its own default
 * instead and a pinch did nothing to the map. On a desktop the same setup worked,
 * because a wheel event bubbles up to the container either way — which is exactly
 * why this reached an iPad before it reached anyone's laptop.
 *
 * Switching the layer off for pointers also means Amap never sees an event at all,
 * so the interaction flags passed to the constructor are belt and braces rather
 * than the mechanism.
 */
export const AMAP_HOST_STYLE = 'position:absolute;inset:0;z-index:0;pointer-events:none'

/** Leaflet events that mean the camera moved. `move` fires throughout a drag, so a pan follows. */
const SYNC_EVENTS = 'move zoom moveend zoomend resize'

/**
 * Leaflet's own zoom animation, matched exactly.
 *
 * Leaflet CSS-scales its panes over 250ms on this curve (see `zoomAnimation` in
 * leaflet.css). The ground has to move on the same curve for the same duration
 * or the markers and the map underneath them visibly disagree for a quarter of
 * a second, which is worse than not animating at all.
 */
const ZOOM_EASING = 'cubic-bezier(0,0,0.25,1)'
const ZOOM_DURATION_MS = 250

/**
 * The Amap (高德) vector basemap, drawn underneath Leaflet.
 *
 * Why a basemap and not a fourth map engine: everything TREK draws on a map —
 * markers, clusters, route polylines, the click handler that turns a pixel back
 * into a place, bounds fitting — is Leaflet, and on an Amap basemap it is
 * already correct, because gcj02Crs.ts puts the whole map into GCJ-02 Web
 * Mercator. Swapping the engine would mean porting all of that. Swapping only
 * what paints the ground means porting none of it.
 *
 * So this component owns one thing: an `AMap.Map` in a div behind Leaflet's
 * panes, kept on the same camera. Every pointer event still belongs to Leaflet
 * — the Amap instance has all of its own interaction switched off and never
 * sees one.
 *
 * **Why bother, when Amap already serves raster tiles TREK can use?** Because
 * those cap out at 1×. `webrd01` refuses every high-DPI parameter, and the
 * `wprd01` tiles that do come back at 512 have no labels on them at all — so on
 * a Retina screen the Chinese text in the raster basemap is always a 2×
 * upscale of a 1× render. amap.com itself does not use rasters; it renders
 * vectors with WebGL, which is why its labels are sharp. This is that.
 *
 * A zoom is the one thing that needs real work. Leaflet animates one by
 * CSS-scaling its panes, and a canvas underneath them does not come along, so
 * the naive version leaves the ground a level behind and snaps at the end —
 * markers sliding smoothly over a map that jumps. `onZoomAnim` below scales the
 * already-drawn frame onto where the new one will land, on Leaflet's own curve
 * and duration, and swaps in the real render at the end. This is the same
 * bookkeeping maplibre-gl-leaflet does, for the same reason.
 */
export function AmapBasemap() {
  const map = useMap()
  const key = useSettingsStore(s => s.settings.amap_js_key || '')
  // useIsDark, not `settings.dark_mode`: that field is `boolean | string` and
  // carries 'auto' and 'off' as strings, both of which are truthy — reading it
  // directly paints the dark basemap under a light app. The hook reads the
  // `.dark` class that applyAppearance() writes, which is the one source of
  // truth and also follows an OS-level switch under 'auto'.
  const dark = useIsDark()
  const amapRef = useRef<AmapMap | null>(null)
  const handlerRef = useRef<(() => void) | null>(null)
  const zoomAnimRef = useRef<((e: L.ZoomAnimEvent) => void) | null>(null)
  const zoomEndRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!key) {
      console.warn('[basemap] the Amap vector basemap is selected but no JS API key is set')
      return
    }

    let cancelled = false
    const container = map.getContainer()

    // Inside the Leaflet container, as its first child: it then resizes with the
    // map and needs no layout of its own. Leaflet's panes start at z-index 200,
    // so anything drawn on the map stays on top without a stacking rule here.
    const host = document.createElement('div')
    host.style.cssText = AMAP_HOST_STYLE
    container.insertBefore(host, container.firstChild)

    // Leaflet paints its own background over whatever is behind it.
    const previousBackground = container.style.background
    container.style.background = 'transparent'

    /**
     * Put the Amap camera where Leaflet's is.
     *
     * `getCenter()` answers in WGS-84 — gcj02Crs converts on the way out — and
     * Amap speaks GCJ-02, so the shift goes back on here. The zoom needs no
     * conversion: both are standard Web Mercator levels over the same 256 px
     * grid, which is exactly why this bridge is three lines rather than a
     * projection.
     */
    // True while Leaflet is animating a zoom. The camera must NOT follow during
    // it: the canvas is being CSS-scaled to stand in for the new zoom, and
    // repainting it at that zoom at the same time applies the change twice.
    let animating = false

    const sync = (amap: AmapMap) => {
      if (animating) return
      const centre = map.getCenter()
      const gcj = wgs84ToGcj02(centre.lat, centre.lng)
      amap.setZoomAndCenter(map.getZoom(), [gcj.lng, gcj.lat], true)
    }

    /**
     * Stand in for the new zoom with a CSS transform, the way Leaflet does for
     * its own panes.
     *
     * The SDK cannot be asked to animate to a target on Leaflet's clock, so the
     * frame that is already drawn is scaled to where the new one will be and
     * swapped for the real render at the end. The anchor is the only point that
     * has to stay put: `e.center` is at container point `p` now and will be at
     * the container's middle `c` when the animation lands, so with the origin at
     * 0,0 the transform is `scale(s)` followed by whatever translation carries
     * `s·p` onto `c`.
     */
    const onZoomAnim = (e: L.ZoomAnimEvent) => {
      const amap = amapRef.current
      if (!amap) return
      animating = true
      const scale = map.getZoomScale(e.zoom, map.getZoom())
      const p = map.latLngToContainerPoint(e.center)
      const c = map.getSize().divideBy(2)
      host.style.transformOrigin = '0 0'
      host.style.transition = `transform ${ZOOM_DURATION_MS}ms ${ZOOM_EASING}`
      host.style.transform = `translate(${c.x - scale * p.x}px, ${c.y - scale * p.y}px) scale(${scale})`
    }

    const onZoomEnd = () => {
      const amap = amapRef.current
      if (!amap) return
      animating = false
      // Repaint at the real zoom BEFORE dropping the transform: clearing it
      // first shows one frame of the old, unscaled bitmap.
      sync(amap)
      requestAnimationFrame(() => {
        host.style.transition = ''
        host.style.transform = ''
      })
    }

    loadAmapSdk(key)
      .then((AMap) => {
        if (cancelled) return
        const centre = map.getCenter()
        const gcj = wgs84ToGcj02(centre.lat, centre.lng)
        const amap = new AMap.Map(host, {
          viewMode: '2D',
          zoom: map.getZoom(),
          center: [gcj.lng, gcj.lat],
          // Belt and braces: with AMAP_HOST_STYLE this map never receives a
          // pointer event, but two maps both reacting to one drag is the failure
          // these prevent if that ever changes.
          //
          // `zoomEnable` is deliberately NOT among them, and the asymmetry is the
          // whole reason for this comment: `dragEnable: false` only refuses user
          // input and leaves setCenter working, but `zoomEnable: false` disables
          // zooming as a capability, so `setZoomAndCenter` silently keeps the zoom
          // it was built with. The ground then tracks a pan perfectly and stays a
          // level behind on every zoom — which reads as a rendering bug, not a
          // flag. The pointer never reaches this map anyway: it sits behind
          // Leaflet's panes, which are what the browser hit-tests.
          dragEnable: false,
          doubleClickZoom: false,
          keyboardEnable: false,
          rotateEnable: false,
          scrollWheel: false,
          touchZoom: false,
          jogEnable: false,
          animateEnable: false,
          // Amap draws its own scale/credit; TREK has both already.
          showLabel: true,
          mapStyle: dark ? 'amap://styles/dark' : 'amap://styles/normal',
          zooms: [2, 20],
        })
        amapRef.current = amap
        sync(amap)
        // Kept in a ref so the cleanup can take off THIS listener. `map.off(events)`
        // without a handler removes every listener for those events, including the
        // ones Leaflet and the rest of MapView rely on.
        handlerRef.current = () => sync(amap)
        map.on(SYNC_EVENTS, handlerRef.current)
        zoomAnimRef.current = onZoomAnim
        zoomEndRef.current = onZoomEnd
        map.on('zoomanim', onZoomAnim)
        map.on('zoomend', onZoomEnd)
      })
      .catch((err) => {
        console.warn('[basemap] the Amap vector basemap did not load', err)
      })

    return () => {
      cancelled = true
      if (handlerRef.current) map.off(SYNC_EVENTS, handlerRef.current)
      if (zoomAnimRef.current) map.off('zoomanim', zoomAnimRef.current)
      if (zoomEndRef.current) map.off('zoomend', zoomEndRef.current)
      handlerRef.current = null
      zoomAnimRef.current = null
      zoomEndRef.current = null
      try {
        amapRef.current?.destroy()
      } catch {
        // Destroying a half-built map throws inside the SDK; the div goes either way.
      }
      amapRef.current = null
      host.remove()
      container.style.background = previousBackground
    }
  }, [map, key, dark])

  return null
}

export default AmapBasemap

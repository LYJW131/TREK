import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import { wgs84ToGcj02 } from '@trek/shared'
import { useSettingsStore } from '../../store/settingsStore'
import { loadAmapSdk, type AmapMap } from './amapLoader'

/** Leaflet events that mean the camera moved. `move` fires throughout a drag, so a pan follows. */
const SYNC_EVENTS = 'move zoom moveend zoomend resize'

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
 * Known gap: Leaflet animates a zoom by CSS-scaling its panes, and the canvas
 * under them does not scale with it, so the ground snaps at the end of a zoom
 * instead of growing with the markers. Panning is continuous (Leaflet fires
 * `move` throughout a drag). Closing that gap means the transform bookkeeping
 * maplibre-gl-leaflet does for the same reason, and is worth doing only if this
 * basemap earns its place first.
 */
export function AmapBasemap() {
  const map = useMap()
  const key = useSettingsStore(s => s.settings.amap_js_key || '')
  const securityCode = useSettingsStore(s => s.settings.amap_js_security_code || '')
  const dark = useSettingsStore(s => s.settings.dark_mode)
  const amapRef = useRef<AmapMap | null>(null)
  const handlerRef = useRef<(() => void) | null>(null)

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
    host.style.cssText = 'position:absolute;inset:0;z-index:0'
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
    const sync = (amap: AmapMap) => {
      const centre = map.getCenter()
      const gcj = wgs84ToGcj02(centre.lat, centre.lng)
      amap.setZoomAndCenter(map.getZoom(), [gcj.lng, gcj.lat], true)
    }

    loadAmapSdk(key, securityCode)
      .then((AMap) => {
        if (cancelled) return
        const centre = map.getCenter()
        const gcj = wgs84ToGcj02(centre.lat, centre.lng)
        const amap = new AMap.Map(host, {
          viewMode: '2D',
          zoom: map.getZoom(),
          center: [gcj.lng, gcj.lat],
          // Every one of these off: Leaflet owns the camera and the pointer, and
          // two maps both reacting to a drag fight each other.
          dragEnable: false,
          zoomEnable: false,
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
      })
      .catch((err) => {
        console.warn('[basemap] the Amap vector basemap did not load', err)
      })

    return () => {
      cancelled = true
      if (handlerRef.current) map.off(SYNC_EVENTS, handlerRef.current)
      handlerRef.current = null
      try {
        amapRef.current?.destroy()
      } catch {
        // Destroying a half-built map throws inside the SDK; the div goes either way.
      }
      amapRef.current = null
      host.remove()
      container.style.background = previousBackground
    }
  }, [map, key, securityCode, dark])

  return null
}

export default AmapBasemap

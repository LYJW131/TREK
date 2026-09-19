import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { gcj02ToWgs84, wgs84ToGcj02 } from '@trek/shared'
import { useIsDark } from '../../hooks/useIsDark'
import { useSettingsStore } from '../../store/settingsStore'
import { loadAmapSdk, type AmapMap } from './amapLoader'
import { attachAmapCamera } from './amapCameraBridge'

/**
 * The backdrop's own style, and `pointer-events` is deliberately NOT `none`.
 *
 * It was, for one version, and the reason is worth keeping: while Leaflet owned
 * the gestures the Amap canvas had to be transparent to pointers, or an iPad
 * could not pinch — a positioned child paints above the container it sits in,
 * and the canvas carries `touch-action: auto` where Leaflet's container carries
 * `none`, so the browser handled the gesture itself and the map never heard
 * about it. Amap drives now, so it has to receive them, and it handles touch
 * itself. Markers are unaffected either way: they live in
 * `.leaflet-marker-pane`, which paints above this.
 */
export const AMAP_HOST_STYLE = 'position:absolute;inset:0;z-index:0'

/**
 * The class that pins `touch-action: none` onto everything the SDK creates
 * beneath it (see index.css).
 *
 * It cannot be an inline style: the elements that receive the touch are Amap's
 * own canvas and wrappers, built after the div is handed over, and Safari reads
 * the touch-action of the hit element rather than intersecting it with its
 * ancestors.
 *
 * It also cannot live on the div Amap is given: the SDK overwrites that div's
 * className with `amap-container` when it takes it over, which silently unhooks
 * the rule. So this sits on a wrapper and Amap gets a child of it.
 */
export const AMAP_HOST_CLASS = 'trek-amap-host'

/** Amap's own zoom range. Its `zooms` option refuses anything outside this. */
const AMAP_MIN_ZOOM = 2
const AMAP_MAX_ZOOM = 20

/**
 * How far a finger may travel and still count as a press rather than a drag.
 *
 * Amap reports a touch long-press as `rightclick`, and it does so whether or
 * not the finger has moved — so panning with a finger held down opened the
 * add-a-place form, which on a map means writing a row nobody asked for. Ten
 * CSS pixels is the usual slop for "did not mean to move"; below it a press is
 * a press, above it the gesture was a pan and the long-press is discarded.
 */
export const PRESS_SLOP_PX = 10

/**
 * The Amap (高德) vector basemap, with Amap driving.
 *
 * Why a basemap and not a fourth map engine: everything TREK draws on a map —
 * markers, clusters, route polylines, bounds fitting, the click that turns a
 * pixel into a place — is Leaflet, and on an Amap basemap it is already
 * correct, because gcj02Crs.ts puts the whole map into GCJ-02 Web Mercator.
 * Swapping the engine would mean porting all of it.
 *
 * **Why Amap owns the camera rather than following Leaflet.** The first version
 * had it the other way round and stood in for a zoom by CSS-scaling the frame
 * it had already drawn, the way maplibre-gl-leaflet does. That is a stretched
 * bitmap that snaps into focus at the end, and it reads as one. amap.com does
 * not do that — measured rather than assumed: through a wheel zoom its canvas
 * takes zero CSS transforms, because it re-renders the vectors at fractional
 * zoom for every frame of the gesture. The only way to get that here is to let
 * the SDK run the gesture.
 *
 * So the wheel, the pinch and the drag belong to Amap, and Leaflet's camera is
 * pushed to match once per frame. Everything Leaflet draws rides along because
 * its camera really did move — this is not a visual trick, and `zoomend`
 * consumers like ReservationOverlay still see what they expect.
 *
 * What has to travel the other way is a press on empty map, both buttons: they
 * land on Amap's canvas now, and MapView turns the left one into "clear the
 * selection" and the right one into "add a place here". Both are forwarded
 * below, converted out of GCJ-02 like every other coordinate crossing this
 * file. A press on a marker needs nothing — markers paint above the canvas.
 */
export function AmapBasemap() {
  const map = useMap()
  const key = useSettingsStore(s => s.settings.amap_js_key || '')
  // useIsDark, not `settings.dark_mode`: that field is `boolean | string` and
  // carries 'auto' and 'off' as strings, both of which are truthy — reading it
  // directly paints the dark basemap under a light app.
  const dark = useIsDark()
  const amapRef = useRef<AmapMap | null>(null)
  const detachRef = useRef<(() => void) | null>(null)

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
    host.className = AMAP_HOST_CLASS
    host.style.cssText = AMAP_HOST_STYLE
    // The SDK renames whatever element it is handed, so it gets a child and the
    // class that carries the touch-action rule stays on the wrapper.
    const mount = document.createElement('div')
    mount.style.cssText = 'position:absolute;inset:0'
    host.appendChild(mount)
    container.insertBefore(host, container.firstChild)

    // Leaflet paints its own background over whatever is behind it.
    const previousBackground = container.style.background
    container.style.background = 'transparent'

    loadAmapSdk(key)
      .then((AMap) => {
        if (cancelled) return
        const centre = map.getCenter()
        const start = wgs84ToGcj02(centre.lat, centre.lng)
        const amap = new AMap.Map(mount, {
          viewMode: '2D',
          zoom: map.getZoom(),
          center: [start.lng, start.lat],
          // The gesture is Amap's now. Rotation stays off because TREK's map has
          // no rotated state to carry back, and the keyboard stays with Leaflet,
          // whose navigation has focus semantics of its own.
          dragEnable: true,
          zoomEnable: true,
          scrollWheel: true,
          touchZoom: true,
          touchZoomCenter: 0,
          doubleClickZoom: true,
          jogEnable: true,
          rotateEnable: false,
          keyboardEnable: false,
          mapStyle: dark ? 'amap://styles/dark' : 'amap://styles/normal',
          // Clamped to what both sides can express, so neither runs past the
          // other and leaves the ground behind at the extremes.
          zooms: [
            Math.max(AMAP_MIN_ZOOM, map.getMinZoom() || AMAP_MIN_ZOOM),
            Math.min(AMAP_MAX_ZOOM, map.getMaxZoom() || AMAP_MAX_ZOOM),
          ],
        })
        amapRef.current = amap

        const detachCamera = attachAmapCamera(map, amap)

        /**
         * A press on empty map, handed back to Leaflet.
         *
         * Both buttons matter and for different reasons. The left one is
         * MapClickHandler, which only clears the selection. The right one is
         * MapContextMenuHandler, which reads `e.latlng` and opens "add a place
         * here" — so an unforwarded right-click is a feature that silently
         * stops existing rather than a cosmetic loss.
         *
         * A press on a marker still reaches Leaflet by itself, because markers
         * paint above this canvas; only the ground arrives here.
         */
        const forward = (type: 'click' | 'contextmenu') => (e: {
          lnglat?: { getLat(): number; getLng(): number }
          pixel?: { getX(): number; getY(): number }
          originalEvent?: MouseEvent
        }) => {
          if (!e.lnglat) return
          const wgs = gcj02ToWgs84(e.lnglat.getLat(), e.lnglat.getLng())
          const latlng = L.latLng(wgs.lat, wgs.lng)
          const containerPoint = e.pixel
            ? L.point(e.pixel.getX(), e.pixel.getY())
            : map.latLngToContainerPoint(latlng)
          map.fire(type, {
            latlng,
            containerPoint,
            layerPoint: map.containerPointToLayerPoint(containerPoint),
            // The handler calls preventDefault() on it to keep the browser's own
            // menu away, so it has to be the real event whenever Amap gives one.
            originalEvent: e.originalEvent ?? new MouseEvent(type),
          })
        }
        const onAmapClick = forward('click')
        const forwardContextMenu = forward('contextmenu')

        /**
         * Did the pointer travel between going down and now?
         *
         * Watched on the wrapper in the capture phase, so it is known before
         * Amap's own handlers run and before the long-press it eventually
         * reports. A drag sets this and the long-press that Amap raises mid-pan
         * is dropped; a still finger leaves it false and the menu opens.
         */
        let pressAt: { x: number; y: number } | null = null
        let pressMoved = false
        const onPointerDown = (e: PointerEvent) => {
          pressAt = { x: e.clientX, y: e.clientY }
          pressMoved = false
        }
        const onPointerMove = (e: PointerEvent) => {
          if (!pressAt) return
          if (Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > PRESS_SLOP_PX) pressMoved = true
        }
        const onPointerUp = () => { pressAt = null }

        const onAmapRightClick = (e: Parameters<typeof forwardContextMenu>[0]) => {
          if (pressMoved) return
          forwardContextMenu(e)
        }

        host.addEventListener('pointerdown', onPointerDown, true)
        host.addEventListener('pointermove', onPointerMove, true)
        host.addEventListener('pointerup', onPointerUp, true)
        host.addEventListener('pointercancel', onPointerUp, true)

        amap.on('click', onAmapClick)
        amap.on('rightclick', onAmapRightClick)
        detachRef.current = () => {
          detachCamera()
          amap.off('click', onAmapClick)
          amap.off('rightclick', onAmapRightClick)
          host.removeEventListener('pointerdown', onPointerDown, true)
          host.removeEventListener('pointermove', onPointerMove, true)
          host.removeEventListener('pointerup', onPointerUp, true)
          host.removeEventListener('pointercancel', onPointerUp, true)
        }
      })
      .catch((err) => {
        console.warn('[basemap] the Amap vector basemap did not load', err)
      })

    return () => {
      cancelled = true
      detachRef.current?.()
      detachRef.current = null
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

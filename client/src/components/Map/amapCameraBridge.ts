import L from 'leaflet'
import { gcj02ToWgs84, wgs84ToGcj02 } from '@trek/shared'
import type { AmapMap } from './amapLoader'

// Leaflet 1.9's animation primitive: unlike setView it neither rounds zoom nor
// resets every layer and fires moveend on every frame. Keep this private API at
// one boundary, exercised by tests using real Leaflet markers and paths.
type AnimatedMap = L.Map & {
  _zoomAnimated: boolean
  _stop(): L.Map
  _move(center: L.LatLng, zoom: number, data: { pinch: boolean }): L.Map
}

const COORD_EPSILON = 1e-9
const ZOOM_EPSILON = 1e-6

/**
 * How many frames the camera has to hold still before the gesture is over.
 *
 * A fixed number of frames after `moveend`/`zoomend` is not enough, because the
 * SDK raises those before its own easing has finished: a wheel zoom then
 * reported two positions to Leaflet while the ground eased through a dozen, and
 * the markers jumped to the end in one step. Watching for the camera to stop
 * changing instead ends the follow when the motion really ends — including
 * inertial panning, which keeps moving long after `dragend`.
 */
const IDLE_FRAMES = 4

/** Amap owns gestures; Leaflet owns app commands and the WGS-84 overlays. */
export function attachAmapCamera(map: L.Map, amap: AmapMap): () => void {
  const camera = map as AnimatedMap
  const container = map.getContainer()
  container.classList.add('trek-amap-active')
  const previous = { zoomSnap: map.options.zoomSnap, zoomAnimated: camera._zoomAnimated }
  const handlers = [map.dragging, map.scrollWheelZoom, map.touchZoom, map.doubleClickZoom, map.boxZoom]
  const enabled = handlers.filter(handler => handler.enabled())
  enabled.forEach(handler => handler.disable())
  map.options.zoomSnap = 0
  // App flyTo/panTo still animate through move events. CSS zoom animations only
  // expose their destination, so they cannot drive a second engine in lockstep.
  camera._zoomAnimated = false

  let syncing = false
  let moving = false
  let zooming = false
  let frame = 0
  let settling = 0
  let touches = 0
  let lastLeafletView: { center: L.LatLng; zoom: number; size: L.Point } | undefined
  const rememberView = () => {
    lastLeafletView = { center: map.getCenter(), zoom: map.getZoom(), size: map.getSize() }
  }
  const onTouch = (event: TouchEvent) => { touches = event.touches.length }
  const touchEvents = ['touchstart', 'touchend', 'touchcancel'] as const
  touchEvents.forEach(event => container.addEventListener(event, onTouch, { capture: true, passive: true }))

  const guarded = (update: () => void) => {
    syncing = true
    try { update() } finally { syncing = false }
  }

  const follow = (force = false): boolean => {
    const center = amap.getCenter()
    const wgs = gcj02ToWgs84(center.lat, center.lng)
    // The SDK defaults to two decimal places, visibly quantizing distant pins.
    const zoom = amap.getZoom(6)
    const at = map.getCenter()
    const changedZoom = Math.abs(map.getZoom() - zoom) > ZOOM_EPSILON
    if (!force && !changedZoom && Math.abs(at.lat - wgs.lat) < COORD_EPSILON && Math.abs(at.lng - wgs.lng) < COORD_EPSILON) return false
    guarded(() => {
      if (!moving) {
        camera._stop()
        moving = true
        map.fire('movestart')
      }
      if (changedZoom && !zooming) {
        zooming = true
        map.fire('zoomstart')
      }
      // pinch also emits zoom for a pan: markers and SVG renderers subscribe
      // to it, and must reproject when the pixel origin changes at fixed zoom.
      // panBy/invalidateSize can leave a translated map pane. Rebase it before
      // changing the pixel origin, as Leaflet's own resetView does; otherwise
      // getCenter re-derives a rounded centre and never agrees with the SDK.
      const pane = map.getPane('mapPane')
      if (pane) L.DomUtil.setPosition(pane, L.point(0, 0))
      camera._move(L.latLng(wgs.lat, wgs.lng), zoom, { pinch: true })
      rememberView()
    })
    return true
  }

  const finish = () => {
    if (!moving) return
    guarded(() => {
      const changedZoom = zooming
      moving = false
      zooming = false
      // Paths need their new origin even after a pan, since _move changed it.
      map.fire('viewreset')
      if (changedZoom) map.fire('zoomend')
      map.fire('moveend')
    })
  }

  const tick = () => {
    frame = 0
    if (follow() || touches > 0) settling = 0
    else if (++settling >= IDLE_FRAMES) { finish(); return }
    frame = requestAnimationFrame(tick)
  }
  const start = () => {
    if (syncing) return
    settling = 0
    // Read in the SDK event as well as rAF, avoiding an extra frame of latency.
    follow()
    if (!frame) frame = requestAnimationFrame(tick)
  }
  const end = () => {
    if (syncing) return
    // moveend and zoomend arrive before the SDK's easing has finished, and
    // dragend arrives before inertia has. Neither ends the follow; the idle
    // count above does, once the camera has actually stopped.
    if (!frame) frame = requestAnimationFrame(tick)
  }

  const resize = () => {
    if (syncing) return
    // Leaflet's resize path also emits move and a delayed moveend. Resizing
    // overlays must never send an older camera back into SDK pinch easing.
    follow(true)
    start()
  }

  const push = () => {
    if (syncing) return
    if (lastLeafletView && !map.getSize().equals(lastLeafletView.size)) {
      resize()
      return
    }
    const center = map.getCenter()
    const zoom = map.getZoom()
    // Compare against the last accepted Leaflet view, not the SDK's current
    // view: the SDK can already be a frame ahead. A notification with no actual
    // Leaflet camera change is not an app command and must not stop following.
    if (lastLeafletView && center.equals(lastLeafletView.center, COORD_EPSILON) && Math.abs(zoom - lastLeafletView.zoom) < ZOOM_EPSILON) return
    rememberView()
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    settling = 0
    moving = false
    zooming = false
    const gcj = wgs84ToGcj02(center.lat, center.lng)
    const at = amap.getCenter()
    if (Math.abs(at.lat - gcj.lat) < COORD_EPSILON && Math.abs(at.lng - gcj.lng) < COORD_EPSILON && Math.abs(amap.getZoom(6) - zoom) < ZOOM_EPSILON) return
    guarded(() => amap.setZoomAndCenter(zoom, [gcj.lng, gcj.lat], true))
  }

  const starts = ['movestart', 'zoomstart', 'mapmove', 'zoomchange']
  const ends = ['moveend', 'zoomend']
  starts.forEach(event => amap.on(event, start))
  ends.forEach(event => amap.on(event, end))
  map.on('move zoom', push)
  map.on('resize', resize)
  push()

  return () => {
    if (frame) cancelAnimationFrame(frame)
    starts.forEach(event => amap.off(event, start))
    ends.forEach(event => amap.off(event, end))
    map.off('move zoom', push)
    map.off('resize', resize)
    touchEvents.forEach(event => container.removeEventListener(event, onTouch, true))
    finish()
    map.options.zoomSnap = previous.zoomSnap
    camera._zoomAnimated = previous.zoomAnimated
    enabled.forEach(handler => handler.enable())
    container.classList.remove('trek-amap-active')
  }
}

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

  const guarded = (update: () => void) => {
    syncing = true
    try { update() } finally { syncing = false }
  }

  const follow = () => {
    const center = amap.getCenter()
    const wgs = gcj02ToWgs84(center.lat, center.lng)
    // The SDK defaults to two decimal places, visibly quantizing distant pins.
    const zoom = amap.getZoom(6)
    const at = map.getCenter()
    const changedZoom = Math.abs(map.getZoom() - zoom) > ZOOM_EPSILON
    if (!changedZoom && Math.abs(at.lat - wgs.lat) < COORD_EPSILON && Math.abs(at.lng - wgs.lng) < COORD_EPSILON) return
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
      camera._move(L.latLng(wgs.lat, wgs.lng), zoom, { pinch: true })
    })
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
    follow()
    if (settling && --settling === 0) finish()
    else frame = requestAnimationFrame(tick)
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
    // moveend and zoomend may precede the final rendered frame. dragend is
    // deliberately excluded: Amap is still moving during inertial deceleration.
    settling = 2
    if (!frame) frame = requestAnimationFrame(tick)
  }

  const push = () => {
    if (syncing) return
    // An app command interrupts the SDK gesture and becomes authoritative.
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    settling = 0
    moving = false
    zooming = false
    const center = map.getCenter()
    const gcj = wgs84ToGcj02(center.lat, center.lng)
    const at = amap.getCenter()
    if (Math.abs(at.lat - gcj.lat) < COORD_EPSILON && Math.abs(at.lng - gcj.lng) < COORD_EPSILON && Math.abs(amap.getZoom(6) - map.getZoom()) < ZOOM_EPSILON) return
    guarded(() => amap.setZoomAndCenter(map.getZoom(), [gcj.lng, gcj.lat], true))
  }

  const starts = ['movestart', 'zoomstart', 'mapmove', 'zoomchange']
  const ends = ['moveend', 'zoomend']
  starts.forEach(event => amap.on(event, start))
  ends.forEach(event => amap.on(event, end))
  map.on('move zoom moveend zoomend resize', push)
  push()

  return () => {
    if (frame) cancelAnimationFrame(frame)
    starts.forEach(event => amap.off(event, start))
    ends.forEach(event => amap.off(event, end))
    map.off('move zoom moveend zoomend resize', push)
    finish()
    map.options.zoomSnap = previous.zoomSnap
    camera._zoomAnimated = previous.zoomAnimated
    enabled.forEach(handler => handler.enable())
    container.classList.remove('trek-amap-active')
  }
}

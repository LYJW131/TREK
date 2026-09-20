import L from 'leaflet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wgs84ToGcj02 } from '@trek/shared'
import { attachAmapCamera } from './amapCameraBridge'
import type { AmapMap } from './amapLoader'
import { getCrsGcj02 } from './gcj02Crs'

let map: L.Map
let container: HTMLDivElement
let detach: (() => void) | undefined
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
const previous3d = L.Browser.any3d
const previousSvg = L.Browser.svg

function flushFrame() {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(performance.now()))
}

/**
 * Run frames until the bridge stops asking for them.
 *
 * The follow ends when the camera has held still for a few frames rather than a
 * fixed count after the SDK's end event, because the SDK raises `zoomend`
 * before its own easing has finished — pinning a number here would pin the
 * wrong contract. The bound only stops a runaway loop from hanging the suite.
 */
function flushUntilIdle(limit = 20) {
  for (let i = 0; i < limit && frames.size; i++) flushFrame()
}

function sdk() {
  class SdkEvents extends L.Evented {}
  const events = new SdkEvents()
  let center = wgs84ToGcj02(map.getCenter().lat, map.getCenter().lng)
  let zoom = map.getZoom()
  const amap: AmapMap = {
    getCenter: () => center,
    getZoom: vi.fn(() => zoom),
    setZoomAndCenter: vi.fn((z, [lng, lat]) => {
      zoom = z
      center = { lat, lng }
      events.fire('mapmove')
      events.fire('moveend')
    }),
    setMapStyle: vi.fn(),
    destroy: vi.fn(),
    on: (name, handler) => { events.on(name, handler) },
    off: (name, handler) => { events.off(name, handler) },
  }
  return {
    amap,
    events,
    move(lat: number, lng: number, z = zoom) {
      center = wgs84ToGcj02(lat, lng)
      zoom = z
    },
  }
}

beforeEach(() => {
  // jsdom has no CSS 3D detection; actual supported browsers do.
  Object.defineProperties(L.Browser, { any3d: { value: true }, svg: { value: true } })
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  container = document.createElement('div')
  Object.defineProperties(container, { clientWidth: { value: 1000 }, clientHeight: { value: 700, configurable: true } })
  document.body.append(container)
  map = L.map(container, { crs: getCrsGcj02(), center: [31.23, 121.47], zoom: 12, maxZoom: 20, zoomControl: false })
})

afterEach(() => {
  detach?.()
  detach = undefined
  map.remove()
  container.remove()
  vi.unstubAllGlobals()
  Object.defineProperties(L.Browser, { any3d: { value: previous3d }, svg: { value: previousSvg } })
})

describe('Amap / Leaflet camera bridge', () => {
  it('keeps real marker anchors on fractional zoom frames without ending the gesture per frame', () => {
    const { amap, events, move } = sdk()
    const marker = L.marker([31.24, 121.49], { icon: L.divIcon({ iconSize: [20, 20], iconAnchor: [10, 20] }) }).addTo(map)
    const ended = vi.fn()
    const reset = vi.fn()
    const started = vi.fn()
    map.on('moveend zoomend', ended).on('viewreset', reset).on('movestart', started)
    detach = attachAmapCamera(map, amap)
    events.fire('zoomstart')
    for (let i = 1; i <= 30; i++) {
      move(31.23 + i * 0.0001, 121.47 + i * 0.0002, 12 + i / 73)
      flushFrame()
      expect(map.getZoom()).toBeCloseTo(12 + i / 73, 6)
      const actual = L.DomUtil.getPosition(marker.getElement()!)
      const expected = map.project(marker.getLatLng()).subtract(map.project(map.getCenter())).add(map.getSize().divideBy(2))
      expect(actual.distanceTo(expected)).toBeLessThan(1.5)
    }
    expect(ended).not.toHaveBeenCalled()
    expect(reset).not.toHaveBeenCalled()
    expect(started).toHaveBeenCalledTimes(1)
    expect(amap.setZoomAndCenter).not.toHaveBeenCalled()
    expect(amap.getZoom).toHaveBeenCalledWith(6)
    events.fire('zoomend')
    flushUntilIdle()
    expect(ended).toHaveBeenCalledTimes(2) // one zoomend and one moveend
    expect(reset).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('continues marker motion after dragend through the last inertial frame', () => {
    const { amap, events, move } = sdk()
    const marker = L.marker([31.24, 121.49]).addTo(map)
    detach = attachAmapCamera(map, amap)
    const initial = L.DomUtil.getPosition(marker.getElement()!).clone()
    const ended = vi.fn()
    map.on('moveend', ended)
    events.fire('movestart')
    move(31.231, 121.472)
    flushFrame()
    events.fire('dragend')
    move(31.232, 121.474)
    flushFrame()
    expect(ended).not.toHaveBeenCalled()
    expect(L.DomUtil.getPosition(marker.getElement()!).distanceTo(initial)).toBeGreaterThan(10)
    events.fire('moveend')
    move(31.233, 121.476) // SDK settles after its end notification
    flushFrame()
    flushUntilIdle()
    expect(map.getCenter().lat).toBeCloseTo(31.233, 6)
    expect(ended).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('keeps SVG route endpoints aligned when a pan changes the overlay pixel origin', () => {
    const { amap, events, move } = sdk()
    const point = L.latLng(31.231, 121.471)
    const route = L.polyline([point, [31.232, 121.472]], { renderer: L.svg() }).addTo(map)
    const path = route.getElement()!
    const initial = path.getAttribute('d')
    detach = attachAmapCamera(map, amap)
    events.fire('movestart')
    move(31.231, 121.472)
    flushFrame()
    events.fire('moveend')
    flushUntilIdle()
    expect(path.getAttribute('d')).not.toBe(initial)
    const start = path.getAttribute('d')!.match(/M(-?[\d.]+)[ ,](-?[\d.]+)/)!
    const actual = L.point(Number(start[1]), Number(start[2]))
    expect(actual.distanceTo(map.latLngToLayerPoint(point))).toBeLessThan(1)
  })

  it('does not rewind SDK easing when a delayed Leaflet notification arrives between frames', () => {
    const { amap, events, move } = sdk()
    detach = attachAmapCamera(map, amap)
    events.fire('zoomstart')
    move(31.231, 121.472, 12.4)
    flushFrame()
    move(31.232, 121.474, 12.6)
    // Leaflet still reflects the previous frame. None of these notifications
    // expresses an app command, even though the SDK is ahead of Leaflet now.
    map.fire('moveend').fire('zoomend').fire('move')
    expect(amap.setZoomAndCenter).not.toHaveBeenCalled()
    flushFrame()
    expect(map.getZoom()).toBe(12.6)
    expect(map.getCenter().lat).toBeCloseTo(31.232, 6)
    flushUntilIdle()
    expect(frames.size).toBe(0)
  })

  it('takes the camera from Amap when the container resizes during pinch settling', () => {
    const { amap, events, move } = sdk()
    detach = attachAmapCamera(map, amap)
    events.fire('zoomstart')
    move(31.231, 121.472, 12.4)
    flushFrame()
    move(31.232, 121.474, 12.6)
    Object.defineProperty(container, 'clientHeight', { value: 760 })
    map.invalidateSize({ debounceMoveend: true })
    expect(amap.setZoomAndCenter).not.toHaveBeenCalled()
    flushFrame()
    expect(map.getZoom()).toBe(12.6)
    expect(map.getCenter().lat).toBeCloseTo(31.232, 6)
    flushUntilIdle()
    expect(frames.size).toBe(0)
    expect(amap.setZoomAndCenter).not.toHaveBeenCalled()
  })

  it('does not end a pinch while fingers pause or while one finger is still down', () => {
    const { amap, events, move } = sdk()
    const touch = (type: string, count: number) => {
      const event = new Event(type)
      Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({})) })
      container.dispatchEvent(event)
    }
    const ended = vi.fn()
    map.on('moveend', ended)
    detach = attachAmapCamera(map, amap)
    touch('touchstart', 2)
    events.fire('zoomstart')
    move(31.231, 121.472, 12.4)
    flushFrame()
    flushUntilIdle()
    expect(ended).not.toHaveBeenCalled()
    touch('touchend', 1)
    events.fire('zoomend')
    flushUntilIdle()
    expect(ended).not.toHaveBeenCalled()
    touch('touchend', 0)
    move(31.232, 121.474, 12.6)
    flushUntilIdle()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('settles at the SDK camera after an app pan has translated the Leaflet pane', () => {
    const { amap, events, move } = sdk()
    detach = attachAmapCamera(map, amap)
    const marker = L.marker([31.24, 121.49]).addTo(map)
    map.panBy([35, 25], { animate: false })
    vi.mocked(amap.setZoomAndCenter).mockClear()
    events.fire('zoomstart')
    move(31.231, 121.472, 12.4)
    flushFrame()
    const expected = map.project(marker.getLatLng()).subtract(map.project([31.231, 121.472])).add(map.getSize().divideBy(2))
    const pane = map.getPane('mapPane')!
    const actual = L.DomUtil.getPosition(marker.getElement()!).add(L.DomUtil.getPosition(pane))
    expect(actual.distanceTo(expected)).toBeLessThan(1.5)
    events.fire('zoomend')
    flushUntilIdle()
    expect(frames.size).toBe(0)
    expect(amap.setZoomAndCenter).not.toHaveBeenCalled()
  })

  it('gives gestures one owner, and restores the original options when changing basemap', () => {
    const { amap } = sdk()
    map.boxZoom.disable()
    detach = attachAmapCamera(map, amap)
    expect(map.options.zoomSnap).toBe(0)
    for (const handler of [map.dragging, map.touchZoom, map.scrollWheelZoom, map.doubleClickZoom]) expect(handler.enabled()).toBe(false)
    expect(map.keyboard.enabled()).toBe(true)
    detach()
    detach = undefined
    expect(map.options.zoomSnap).toBe(1)
    for (const handler of [map.dragging, map.touchZoom, map.scrollWheelZoom, map.doubleClickZoom]) expect(handler.enabled()).toBe(true)
    expect(map.boxZoom.enabled()).toBe(false)
  })

  it('carries app camera changes to the SDK during motion without an event feedback loop', () => {
    const { amap } = sdk()
    detach = attachAmapCamera(map, amap)
    map.setView([31.25, 121.48], 13.25, { animate: false })
    expect(amap.setZoomAndCenter).toHaveBeenCalledTimes(1)
    expect(amap.getZoom()).toBe(13.25)
    expect(frames.size).toBe(0)
    map.panBy([30, 20], { animate: false })
    expect(amap.setZoomAndCenter).toHaveBeenCalledTimes(2)
    expect(frames.size).toBe(0)
  })

  it('cancels scheduled work and SDK listeners on detach, including a mid-gesture detach', () => {
    const { amap, events, move } = sdk()
    detach = attachAmapCamera(map, amap)
    events.fire('movestart')
    move(31.24, 121.48)
    flushFrame()
    detach()
    detach = undefined
    expect(frames.size).toBe(0)
    const center = map.getCenter()
    events.fire('mapmove')
    move(32, 122)
    flushFrame()
    expect(map.getCenter()).toEqual(center)
    expect(frames.size).toBe(0)
  })
})

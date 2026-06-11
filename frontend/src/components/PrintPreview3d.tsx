import { useEffect, useRef } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { type Model3D, FEATURE_COLORS } from "../utils/gcode3d"

export type ColorMode = "progress" | "feature" | "speed"

interface Props {
  model: Model3D | null
  progress: number
  buildVolume?: [number, number, number] | null
  toolhead?: { x: number; y: number; z: number } | null
  colorMode?: ColorMode
  showTravel?: boolean
  printedColor?: string
  skeletonColor?: string
}

// Builds a small X/Y/Z gizmo (colored arrows + labels) for the corner overlay.
// Builds a small X/Y/Z gizmo (colored arrows + dot tips + letter labels).
function makeGizmo(): THREE.Group {
  const g = new THREE.Group()
  const L = 1

  const makeLabel = (text: string, color: string): THREE.Sprite => {
    const c = document.createElement("canvas")
    c.width = 
    c.height = 64
    const ctx = c.getContext("2d")!
    ctx.fillStyle = color
    ctx.font = "bold 44px sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(text, 32, 34)
    const tex = new THREE.CanvasTexture(c)
    tex.minFilter = THREE.LinearFilter
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
    const sprite = new THREE.Sprite(mat)
    sprite.scale.set(0.55, 0.55, 0.55)
    return sprite
  }

  const axes: [THREE.Vector3, number, string, string][] = [
    [new THREE.Vector3(1, 0, 0), 0xef4444, "X", "#ef4444"], // gcode X
    [new THREE.Vector3(0, 1, 0), 0x60a5fa, "Z", "#60a5fa"], // up = gcode Z
    [new THREE.Vector3(0, 0, 1), 0x4ade80, "Y", "#4ade80"], // depth = gcode Y
  ]

  for (const [dir, color, letter, css] of axes) {
    const mat = new THREE.LineBasicMaterial({ color })
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      dir.clone().multiplyScalar(L),
    ])
    g.add(new THREE.Line(geo, mat))

    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 10, 10),
      new THREE.MeshBasicMaterial({ color })
    )
    tip.position.copy(dir.clone().multiplyScalar(L))
    g.add(tip)

    const label = makeLabel(letter, css)
    label.position.copy(dir.clone().multiplyScalar(L * 1.35))
    g.add(label)
  }

  return g
}

export default function PrintPreview3D({
  model,
  progress,
  buildVolume = null,
  toolhead = null,
  colorMode = "progress",
  showTravel = false,
  printedColor = "#4ade80",
  skeletonColor = "#e2e8f0",
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null)

  const progressRef = useRef(progress); progressRef.current = progress
  const toolheadRef = useRef(toolhead); toolheadRef.current = toolhead

  const printedGeoRef = useRef<THREE.BufferGeometry | null>(null)
  const colorArraysRef = useRef<{ green: Float32Array; feat: Float32Array; spd: Float32Array } | null>(null)
  const travelRef = useRef<THREE.LineSegments | null>(null)

  const bvx = buildVolume?.[0] ?? null
  const bvy = buildVolume?.[1] ?? null
  const bvz = buildVolume?.[2] ?? null

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !model || !model.bounds || model.segmentCount === 0) return

    const width = mount.clientWidth || 400
    const height = mount.clientHeight || 400

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d1117)
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(width, height)
    renderer.autoClear = false // we render the main scene then the gizmo overlay
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.panSpeed = 1.0
    controls.keyPanSpeed = 25
    controls.listenToKeyEvents(window)
    controls.keys = { LEFT: "ArrowLeft", UP: "ArrowUp", RIGHT: "ArrowRight", BOTTOM: "ArrowDown" }
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

    // ---- corner orientation gizmo (its own scene + camera) ----
    const gizmoScene = new THREE.Scene()
    const gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10)
    gizmoCam.position.set(0, 0, 5)
    const gizmo = makeGizmo()
    gizmoScene.add(gizmo)
    const GIZMO_SIZE = 90 // px

    const { min, max } = model.bounds
    const haveBox = bvx != null && bvy != null && bvz != null

    const cx = haveBox ? bvx! / 2 : (min[0] + max[0]) / 2
    const cy = haveBox ? bvy! / 2 : (min[1] + max[1]) / 2
    const cz = haveBox ? bvz! / 2 : (min[2] + max[2]) / 2
    const tx = (gx: number) => gx - cx
    const tyUp = (gz: number) => gz - cz
    const tz = (gy: number) => gy - cy

    const src = model.positions
    const pos = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
      pos[i] = src[i] - cx
      pos[i + 1] = src[i + 2] - cz
      pos[i + 2] = src[i + 1] - cy
    }
    const geoBase = new THREE.BufferGeometry()
    geoBase.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    const geoPrinted = new THREE.BufferGeometry()
    geoPrinted.setAttribute("position", new THREE.BufferAttribute(pos, 3))

    const vcount = model.segmentCount * 2
    const green = new Float32Array(vcount * 3)
    const feat = new Float32Array(vcount * 3)
    const spd = new Float32Array(vcount * 3)
    const gc = new THREE.Color(printedColor)
    const featCols = FEATURE_COLORS.map((h) => new THREE.Color(h))
    const span = Math.max(model.feedMax - model.feedMin, 1)
    for (let i = 0; i < model.segmentCount; i++) {
      const fc = featCols[model.featureType[i]] || featCols[0]
      let t = (model.feed[i] - model.feedMin) / span
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const r = 0.15 + t * 0.79
      const g = 0.4 - t * 0.13
      const b = 0.95 - t * 0.68
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3
        green[o] = gc.r; green[o + 1] = gc.g; green[o + 2] = gc.b
        feat[o] = fc.r; feat[o + 1] = fc.g; feat[o + 2] = fc.b
        spd[o] = r; spd[o + 1] = g; spd[o + 2] = b
      }
    }
    colorArraysRef.current = { green, feat, spd }
    const initial = colorMode === "feature" ? feat : colorMode === "speed" ? spd : green
    geoPrinted.setAttribute("color", new THREE.BufferAttribute(initial.slice(), 3))
    printedGeoRef.current = geoPrinted

    const baseMat = new THREE.LineBasicMaterial({ color: new THREE.Color(skeletonColor), transparent: true, opacity: 0.3 })
    const printedMat = new THREE.LineBasicMaterial({ vertexColors: true })
    const base = new THREE.LineSegments(geoBase, baseMat)
    const printed = new THREE.LineSegments(geoPrinted, printedMat)
    scene.add(base); scene.add(printed)
    const totalVerts = model.segmentCount * 2

    let radius: number
    if (haveBox) radius = Math.sqrt(bvx! * bvx! + bvy! * bvy! + bvz! * bvz!) / 2
    else { geoBase.computeBoundingSphere(); radius = geoBase.boundingSphere?.radius ?? 100 }
    camera.position.set(radius * 1.3, radius * 1.1, radius * 1.7)
    camera.lookAt(0, 0, 0); controls.target.set(0, 0, 0); controls.update()

    const gridSize = haveBox ? Math.max(bvx!, bvy!) : radius * 2
    const grid = new THREE.GridHelper(gridSize, 8, 0x94a3b8, 0x475569)
    grid.position.y = tyUp(haveBox ? 0 : min[2])
    const gridMat = grid.material as THREE.Material
    gridMat.transparent = true; gridMat.opacity = 0.5
    scene.add(grid)

    let boxGeo: THREE.BoxGeometry | null = null
    let edgesGeo: THREE.EdgesGeometry | null = null
    let boxMat: THREE.LineBasicMaterial | null = null
    if (haveBox) {
      boxGeo = new THREE.BoxGeometry(bvx!, bvz!, bvy!)
      edgesGeo = new THREE.EdgesGeometry(boxGeo)
      boxMat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.6 })
      const boxEdges = new THREE.LineSegments(edgesGeo, boxMat)
      boxEdges.position.set(0, 0, 0)
      scene.add(boxEdges)
    }

    const axisLen = (haveBox ? Math.max(bvx!, bvy!, bvz!) : radius) * 0.25
    const axes = new THREE.AxesHelper(axisLen)
    axes.position.set(tx(0), tyUp(0), tz(0))
    scene.add(axes)
    const originGeo = new THREE.SphereGeometry(axisLen * 0.06, 12, 12)
    const originMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 })
    const origin = new THREE.Mesh(originGeo, originMat)
    origin.position.set(tx(0), tyUp(0), tz(0))
    scene.add(origin)

    let travelGeo: THREE.BufferGeometry | null = null
    let travelMat: THREE.LineDashedMaterial | null = null
    if (model.travelPositions.length) {
      const ts = model.travelPositions
      const tp = new Float32Array(ts.length)
      for (let i = 0; i < ts.length; i += 3) { tp[i] = ts[i] - cx; tp[i + 1] = ts[i + 2] - cz; tp[i + 2] = ts[i + 1] - cy }
      travelGeo = new THREE.BufferGeometry()
      travelGeo.setAttribute("position", new THREE.BufferAttribute(tp, 3))
      travelMat = new THREE.LineDashedMaterial({ color: 0x64748b, transparent: true, opacity: 0.45, dashSize: radius * 0.02, gapSize: radius * 0.02 })
      const travel = new THREE.LineSegments(travelGeo, travelMat)
      travel.computeLineDistances()
      travel.visible = showTravel
      travelRef.current = travel
      scene.add(travel)
    }

    const markerGeo = new THREE.SphereGeometry(radius * 0.025, 16, 16)
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xfb923c })
    const marker = new THREE.Mesh(markerGeo, markerMat)
    marker.visible = false
    scene.add(marker)

    const bandPts = new Float32Array([
      tx(min[0]), 0, tz(min[1]),
      tx(max[0]), 0, tz(min[1]),
      tx(max[0]), 0, tz(max[1]),
      tx(min[0]), 0, tz(max[1]),
    ])
    const bandGeo = new THREE.BufferGeometry()
    bandGeo.setAttribute("position", new THREE.BufferAttribute(bandPts, 3))
    const bandMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.9 })
    const band = new THREE.LineLoop(bandGeo, bandMat)
    band.visible = false
    scene.add(band)

    const mzMin = min[2], mzMax = max[2]

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const frac = Math.min(Math.max(progressRef.current, 0), 100) / 100
      const printedVerts = Math.round(frac * model.segmentCount) * 2
      geoPrinted.setDrawRange(0, printedVerts)
      geoBase.setDrawRange(printedVerts, totalVerts - printedVerts)

      const th = toolheadRef.current
      if (th) {
        marker.visible = true
        marker.position.set(tx(th.x), tyUp(th.z), tz(th.y))
        const inRange = th.z >= mzMin && th.z <= mzMax
        band.visible = inRange
        band.position.y = tyUp(th.z)
      } else {
        marker.visible = false
        band.visible = false
      }

      controls.update()

      // --- main scene (full viewport) ---
      const w = renderer.domElement.clientWidth
      const h = renderer.domElement.clientHeight
      renderer.setViewport(0, 0, w, h)
      renderer.setScissor(0, 0, w, h)
      renderer.setScissorTest(false)
      renderer.clear()
      renderer.render(scene, camera)

      // --- gizmo overlay (bottom-left) ---
      gizmo.quaternion.copy(camera.quaternion).invert() // mirror camera orientation
      renderer.clearDepth()
      renderer.setViewport(8, 8, GIZMO_SIZE, GIZMO_SIZE)
      renderer.render(gizmoScene, gizmoCam)
      renderer.setViewport(0, 0, w, h)
    }
    animate()

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight
      if (w && h) { camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h) }
    })
    ro.observe(mount)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      geoBase.dispose(); geoPrinted.dispose(); baseMat.dispose(); printedMat.dispose()
      grid.geometry.dispose(); (grid.material as THREE.Material).dispose()
      edgesGeo?.dispose(); boxGeo?.dispose(); boxMat?.dispose()
      axes.dispose(); originGeo.dispose(); originMat.dispose()
      travelGeo?.dispose(); travelMat?.dispose()
      markerGeo.dispose(); markerMat.dispose()
      bandGeo.dispose(); bandMat.dispose()
      gizmo.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
        const mm = m.material as THREE.Material
        if (mm && mm.dispose) mm.dispose()
      })
      renderer.dispose()
      printedGeoRef.current = null; colorArraysRef.current = null; travelRef.current = null
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, bvx, bvy, bvz])

  useEffect(() => {
    const g = printedGeoRef.current, arrs = colorArraysRef.current
    if (!g || !arrs) return
    const src = colorMode === "feature" ? arrs.feat : colorMode === "speed" ? arrs.spd : arrs.green
    const attr = g.getAttribute("color") as THREE.BufferAttribute
    ;(attr.array as Float32Array).set(src)
    attr.needsUpdate = true
  }, [colorMode])

  useEffect(() => {
    if (travelRef.current) travelRef.current.visible = showTravel
  }, [showTravel])

  if (!model || model.segmentCount === 0) {
    return <div className="text-slate-500 font-mono text-sm">No print loaded</div>
  }
  return <div ref={mountRef} className="w-full h-full" />
}
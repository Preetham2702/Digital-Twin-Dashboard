import { useEffect, useRef } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { Model3D } from "../utils/gcode3d"

interface Props {
  model: Model3D | null
  /** Live progress 0-100 — fraction of segments shown as printed. */
  progress: number
  /** Printed-segment color. Pass red while printing, green when complete. */
  printedColor?: string
  skeletonColor?: string
}

export default function PrintPreview3D({
  model,
  progress,
  printedColor = "#ef4444",
  skeletonColor = "#e2e8f0",
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const progressRef = useRef(progress)
  progressRef.current = progress

  // Material refs so colors can change without rebuilding the whole scene.
  const printedMatRef = useRef<THREE.LineBasicMaterial | null>(null)
  const baseMatRef = useRef<THREE.LineBasicMaterial | null>(null)

  // Build the scene only when the model changes (NOT on color change).
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
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const { min, max } = model.bounds
    const cx = (min[0] + max[0]) / 2
    const cy = (min[1] + max[1]) / 2
    const cz = (min[2] + max[2]) / 2

    const src = model.positions
    const pos = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
      pos[i] = src[i] - cx          // X
      pos[i + 1] = src[i + 2] - cz  // Y (up) = gcode Z
      pos[i + 2] = src[i + 1] - cy  // Z = gcode Y
    }

    const geoBase = new THREE.BufferGeometry()
    geoBase.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    const geoPrinted = new THREE.BufferGeometry()
    geoPrinted.setAttribute("position", new THREE.BufferAttribute(pos, 3))

    const baseMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(skeletonColor),
      transparent: true,
      opacity: 0.5,
    })
    const printedMat = new THREE.LineBasicMaterial({ color: new THREE.Color(printedColor) })
    baseMatRef.current = baseMat
    printedMatRef.current = printedMat

    const base = new THREE.LineSegments(geoBase, baseMat)
    const printed = new THREE.LineSegments(geoPrinted, printedMat)
    scene.add(base)
    scene.add(printed)

    const totalVerts = model.segmentCount * 2

    geoBase.computeBoundingSphere()
    const r = geoBase.boundingSphere?.radius ?? 100
    camera.position.set(r * 1.2, r * 1.0, r * 1.6)
    camera.lookAt(0, 0, 0)
    controls.target.set(0, 0, 0)
    controls.update()

    const grid = new THREE.GridHelper(r * 2, 10, 0x94a3b8, 0x64748b)
    grid.position.y = min[2] - cz
    const gridMat = grid.material as THREE.Material
    gridMat.transparent = true
    gridMat.opacity = 0.7
    scene.add(grid)

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const frac = Math.min(Math.max(progressRef.current, 0), 100) / 100
      const printedVerts = Math.round(frac * model.segmentCount) * 2
      geoPrinted.setDrawRange(0, printedVerts)
      geoBase.setDrawRange(printedVerts, totalVerts - printedVerts)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (w && h) {
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h)
      }
    })
    ro.observe(mount)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      geoBase.dispose()
      geoPrinted.dispose()
      baseMat.dispose()
      printedMat.dispose()
      renderer.dispose()
      baseMatRef.current = null
      printedMatRef.current = null
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
    }
    // Rebuild only when the model changes — color updates handled separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  // Recolor in place (no rebuild, no camera reset) when colors change.
  useEffect(() => {
    printedMatRef.current?.color.set(printedColor)
  }, [printedColor])

  useEffect(() => {
    baseMatRef.current?.color.set(skeletonColor)
  }, [skeletonColor])

  if (!model || model.segmentCount === 0) {
    return <div className="text-slate-500 font-mono text-sm">No print loaded</div>
  }

  return <div ref={mountRef} className="w-full h-full" />
}
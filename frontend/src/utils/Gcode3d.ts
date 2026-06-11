export type Model3D = {
  /** Flat XYZ pairs: [x0,y0,z0, x1,y1,z1, ...], two verts per segment, in print order. */
  positions: Float32Array
  segmentCount: number
  bounds: { min: [number, number, number]; max: [number, number, number] } | null
}

const AXIS = /([XYZEF])(-?\d*\.?\d+)/g

/**
 * Parse sliced G-code into 3D extrusion segments, kept in print order so the
 * "printed so far" fraction maps directly onto progress. Handles G90/G91
 * (absolute/relative XYZ), M82/M83 (absolute/relative E) and G92 (set E).
 * Runs on the lines you already hold in gcodeRef.current.
 */
export function parseGcode3D(lines: string[]): Model3D {
  let absPos = true
  let absE = true
  let x = 0, y = 0, z = 0, e = 0

  const pts: number[] = []
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (const raw of lines) {
    const line = raw.split(";")[0].trim()
    if (!line) continue
    const head = line.split(" ")[0].toUpperCase()

    if (head === "G90") { absPos = true; continue }
    if (head === "G91") { absPos = false; continue }
    if (head === "M82") { absE = true; continue }
    if (head === "M83") { absE = false; continue }
    if (head === "G92") {
      AXIS.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = AXIS.exec(line))) if (m[1] === "E") e = parseFloat(m[2])
      continue
    }
    if (head !== "G0" && head !== "G1") continue

    const px = x, py = y, pz = z
    let newE: number | null = null
    AXIS.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = AXIS.exec(line))) {
      const v = parseFloat(m[2])
      switch (m[1]) {
        case "X": x = absPos ? v : x + v; break
        case "Y": y = absPos ? v : y + v; break
        case "Z": z = absPos ? v : z + v; break
        case "E": newE = v; break
      }
    }

    let extruding = false
    if (newE !== null) {
      const de = absE ? newE - e : newE
      extruding = de > 0
      e = absE ? newE : e + newE
    }

    if (extruding) {
      pts.push(px, py, pz, x, y, z)
      if (px < minX) minX = px; if (x < minX) minX = x
      if (px > maxX) maxX = px; if (x > maxX) maxX = x
      if (py < minY) minY = py; if (y < minY) minY = y
      if (py > maxY) maxY = py; if (y > maxY) maxY = y
      if (pz < minZ) minZ = pz; if (z < minZ) minZ = z
      if (pz > maxZ) maxZ = pz; if (z > maxZ) maxZ = z
    }
  }

  if (!pts.length) {
    return { positions: new Float32Array(0), segmentCount: 0, bounds: null }
  }

  return {
    positions: new Float32Array(pts),
    segmentCount: pts.length / 6,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  }
}
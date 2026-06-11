export type Model3D = {
  /** Extruding segment vertex pairs: [x0,y0,z0, x1,y1,z1, ...]. */
  positions: Float32Array
  /** Non-extruding (travel) segment vertex pairs. */
  travelPositions: Float32Array
  /** Feature-type index per extruding segment (see FEATURE_LABELS). */
  featureType: Uint8Array
  /** Feed rate (mm/min) per extruding segment. */
  feed: Float32Array
  segmentCount: number
  feedMin: number
  feedMax: number
  bounds: { min: [number, number, number]; max: [number, number, number] } | null
}

// Index 0 = "Other"; keep these two arrays in sync.
export const FEATURE_COLORS = [
  "#94a3b8", // other
  "#2dd4bf", // outer wall
  "#60a5fa", // inner wall
  "#a78bfa", // infill
  "#f59e0b", // support
  "#f97316", // top / skin
  "#f472b6", // skirt / brim
]
export const FEATURE_LABELS = [
  "Other",
  "Outer wall",
  "Inner wall",
  "Infill",
  "Support",
  "Top / skin",
  "Skirt / brim",
]

const AXIS = /([XYZEF])(-?\d*\.?\d+)/g

// Maps slicer ;TYPE: strings (Cura / PrusaSlicer / OrcaSlicer) to a feature index.
function classifyType(t: string): number {
  const s = t.toLowerCase()
  if (s.includes("outer") || s.includes("external")) return 1
  if (s.includes("inner") || s.includes("perimeter") || s.includes("wall")) return 2
  if (s.includes("support")) return 4
  if (s.includes("top") || s.includes("skin")) return 5
  if (s.includes("skirt") || s.includes("brim")) return 6
  if (s.includes("infill") || s.includes("fill")) return 3
  return 0
}

export function parseGcode3D(lines: string[]): Model3D {
  let absPos = true
  let absE = true
  let x = 0, y = 0, z = 0, e = 0, f = 0
  let feature = 0

  const pts: number[] = []
  const travels: number[] = []
  const ftypes: number[] = []
  const feeds: number[] = []

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let feedMin = Infinity, feedMax = -Infinity

  for (const raw of lines) {
    // Read ;TYPE: from the comment BEFORE stripping it.
    const semi = raw.indexOf(";")
    if (semi >= 0) {
      const c = raw.slice(semi + 1).trim()
      if (c.toUpperCase().startsWith("TYPE:")) feature = classifyType(c.slice(5))
    }

    const line = (semi >= 0 ? raw.slice(0, semi) : raw).trim()
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
        case "F": f = v; break
      }
    }

    let extruding = false
    if (newE !== null) {
      const de = absE ? newE - e : newE
      extruding = de > 0
      e = absE ? newE : e + newE
    }

    const moved = x !== px || y !== py || z !== pz

    if (extruding) {
      pts.push(px, py, pz, x, y, z)
      ftypes.push(feature)
      feeds.push(f)
      if (f > 0) {
        if (f < feedMin) feedMin = f
        if (f > feedMax) feedMax = f
      }
      if (px < minX) minX = px; if (x < minX) minX = x
      if (px > maxX) maxX = px; if (x > maxX) maxX = x
      if (py < minY) minY = py; if (y < minY) minY = y
      if (py > maxY) maxY = py; if (y > maxY) maxY = y
      if (pz < minZ) minZ = pz; if (z < minZ) minZ = z
      if (pz > maxZ) maxZ = pz; if (z > maxZ) maxZ = z
    } else if (moved) {
      travels.push(px, py, pz, x, y, z)
    }
  }

  if (!pts.length) {
    return {
      positions: new Float32Array(0),
      travelPositions: new Float32Array(0),
      featureType: new Uint8Array(0),
      feed: new Float32Array(0),
      segmentCount: 0,
      feedMin: 0,
      feedMax: 1,
      bounds: null,
    }
  }

  return {
    positions: new Float32Array(pts),
    travelPositions: new Float32Array(travels),
    featureType: new Uint8Array(ftypes),
    feed: new Float32Array(feeds),
    segmentCount: pts.length / 6,
    feedMin: feedMin === Infinity ? 0 : feedMin,
    feedMax: feedMax === -Infinity ? 1 : feedMax,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  }
}
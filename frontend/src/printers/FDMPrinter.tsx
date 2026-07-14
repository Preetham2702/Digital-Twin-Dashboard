import { useEffect, useState, useRef, useMemo } from "react"
import SemiGauge from "../components/SemiGauge"
import PrintPreview3D, { type ColorMode } from "../components/PrintPreview3d"
import { parseGcode3D, type Model3D, FEATURE_COLORS, FEATURE_LABELS } from "../utils/Gcode3d.ts"
import ConfirmDialog from "../components/ConfirmDialog"
import ConnectionOverlay from "../components/ConnectionOverlay"
import BedAlert from "../components/bedalert"
import type { MachineSummary } from "../types/machine"

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer
} from "recharts"

// 🟢 PREVIEW: set this to your printer's real bed size [X, Y, Z] in mm
const BUILD_VOLUME: [number, number, number] = [256, 256, 256]

// 🟢 PREVIEW: feature legend rows (skip index 0 = "Other")
const FEATURE_LEGEND = FEATURE_LABELS
  .map((l, i) => [FEATURE_COLORS[i], l] as [string, string])
  .slice(1)

// 🟢 CACHE: keys + limits for surviving a refresh without the "disconnected" flash.
const SNAP_KEY = "fdm_snapshot"                 // last-known telemetry (localStorage)
const SNAP_MAX_AGE = 6 * 60 * 60 * 1000         // ignore snapshots older than 6h
const GCODE_CACHE_PREFIX = "fdm_gcode:"         // raw g-code text per file (sessionStorage)
const GCODE_CACHE_MAX = 3 * 1024 * 1024         // don't cache files larger than ~3MB

type FdmSnapshot = {
  status: string
  progress: number
  nozzleTemp: number
  nozzleTarget: number
  bedTemp: number
  bedTarget: number
  x: number
  y: number
  z: number
  ts: number
}

// Read the last cached snapshot (or null if missing / too old / unparseable).
function loadFdmSnap(): FdmSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as FdmSnapshot
    if (!s.ts || Date.now() - s.ts > SNAP_MAX_AGE) return null
    return s
  } catch {
    return null
  }
}

export default function FDM({
  onConnectionChange,
  onSummary,
}: {
  onConnectionChange?: (v: boolean) => void
  onSummary?: (s: MachineSummary) => void
}) {

  // 🟢 CACHE: hydrate from the last snapshot so a refresh paints last-known
  // values immediately instead of flashing "disconnected" + zeros. `connected`
  // intentionally stays false until a real live message confirms the link.
  const snap0 = useMemo(loadFdmSnap, [])

  const [connected, setConnected] = useState(false)

  // 🟠 BED ALERT: true while a finished print is still detected on the bed.
  const [bedAlert, setBedAlert] = useState(false)

  // 💡 LIGHT: machine case-light on/off state.
  const [lightOn, setLightOn] = useState(false)

  const [status, setStatus] = useState(snap0?.status ?? "Idle")
  const [progress, setProgress] = useState(snap0?.progress ?? 0)

  const [nozzleTemp, setNozzleTemp] = useState(snap0?.nozzleTemp ?? 0)
  const [nozzleTarget, setNozzleTarget] = useState(snap0?.nozzleTarget ?? 0)
  const [bedTemp, setBedTemp] = useState(snap0?.bedTemp ?? 0)
  const [bedTarget, setBedTarget] = useState(snap0?.bedTarget ?? 0)

  const [x, setX] = useState(snap0?.x ?? 0)
  const [y, setY] = useState(snap0?.y ?? 0)
  const [z, setZ] = useState(snap0?.z ?? 0)

  // 🟢 SPINNER: short grace window so a normal refresh (printer actually fine)
  // doesn't flash the spinner before the first live message lands. If there's
  // no cached snapshot to show, allow the spinner immediately.
  const [graceOver, setGraceOver] = useState(() => !snap0)
  useEffect(() => {
    if (graceOver) return
    const t = setTimeout(() => setGraceOver(true), 1200)
    return () => clearTimeout(t)
  }, [graceOver])

  // 🟢 CACHE: guards a concurrent first-load race so the same file isn't
  // fetched/parsed by all three call sites at once.
  const loadingFileRef = useRef<string | null>(null)

  const [uploadMessage, setUploadMessage] = useState("")
  const [actionMessage, setActionMessage] = useState("")

  // 🔥 which action is awaiting confirmation (replaces window.confirm)
  const [confirmAction, setConfirmAction] = useState<null | "start" | "pause" | "stop">(null)

  const [printerFiles, setPrinterFiles] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState("")

  const socketRef = useRef<WebSocket | null>(null)

  const [motionData, setMotionData] = useState<
    { time: number; feed: number; velocity: number }[]
  >([])

  const [gcodeLines, setGcodeLines] = useState<string[]>([])
  const [currentLine, setCurrentLine] = useState<number>(0)
  const gcodeRef = useRef<string[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [startLine, setStartLine] = useState(0)
  const [windowStart, setWindowStart] = useState(0)
  const WINDOW_SIZE = 20
  const hasLoadedRef = useRef(false)
  const lastLineRef = useRef(-1)

  // 🟢 PREVIEW: parsed 3D toolpath model + toggle for the old text viewer
  const [model3d, setModel3d] = useState<Model3D | null>(null)
  const SHOW_GCODE_VIEWER = false // flip to true to bring the old G-code text viewer back

  // 🟢 PREVIEW: view options
  const [colorMode, setColorMode] = useState<ColorMode>("progress")
  const [showTravel, setShowTravel] = useState(false)

  // 🟢 PREVIEW: track previous UI state so we only clear when a print actually ends
  const prevUiStateRef = useRef("")

  // =============================
  // FETCH FILES
  // =============================
  const fetchFiles = async () => {
    try {
      const res = await fetch("http://localhost:8000/files")
      if (res.ok) {
        const data = await res.json()

        console.log("FILES RESPONSE:", data) // optional debug

        setPrinterFiles(data.files || [])
      }
    } catch {
      console.error("Failed to fetch printer files")
    }
  }
  const executableLinesRef = useRef<number[]>([])

  const fetchGcode = async (filename: string) => {
    try {
      if (!filename || filename === "Select file...") return

      const cleanFile = filename.replace(".cache/", "")

      // 🟢 CACHE: dedupe the concurrent first-load race (WS msg + checkRunning +
      // selectedFile effect can all fire before any completes).
      if (loadingFileRef.current === cleanFile) return
      loadingFileRef.current = cleanFile

      try {
        // 🟢 CACHE: try the in-tab raw-text cache first — skips the network
        // download entirely on refresh. We still parse locally (fast).
        const cacheKey = `${GCODE_CACHE_PREFIX}${cleanFile}`
        let text = ""
        try {
          text = sessionStorage.getItem(cacheKey) || ""
        } catch {
          text = ""
        }

        if (!text) {
          const res = await fetch(`http://localhost:8000/gcode?file=${cleanFile}`)
          if (!res.ok) return

          text = await res.text()
          if (!text || text.length < 10) return

          // Only cache reasonably sized files (localStorage/sessionStorage cap
          // is ~5MB per origin — a huge file would evict everything else).
          if (text.length <= GCODE_CACHE_MAX) {
            try {
              sessionStorage.setItem(cacheKey, text)
            } catch {
              /* quota — fine, we just re-fetch next time */
            }
          }
        }

      // =============================
      // 🔥 FIX ESCAPED NEWLINES
      // =============================
      let lines = text.replace(/\\n/g, "\n").split("\n")

      // =============================
      // 🔥 REMOVE THUMBNAIL BLOCK
      // =============================
      const thumbStart = lines.findIndex(l => l.includes("thumbnail begin"))
      const thumbEnd = lines.findIndex(l => l.includes("thumbnail end"))

      if (thumbStart !== -1 && thumbEnd !== -1) {
        lines.splice(thumbStart, thumbEnd - thumbStart + 1)
      }

      // =============================
      // 🔥 REMOVE HEADER (REAL START)
      // =============================
      const startIdxRaw = lines.findIndex(line => {
        const clean = line.trim()
        if (!clean || clean.startsWith(";")) return false
        return clean.startsWith("G") || clean.startsWith("M")
      })

      if (startIdxRaw > 0) {
        lines = lines.slice(startIdxRaw)
      }

      // =============================
      // 🔥 STORE FULL FILE
      // =============================
      gcodeRef.current = lines

      // 🟢 PREVIEW: build the 3D toolpath model from the freshly loaded gcode
      setModel3d(parseGcode3D(lines))

      // =============================
      // 🔥 BUILD EXECUTABLE LINE MAP (CRITICAL)
      // ONLY REAL PRINTING MOVES
      // =============================
      executableLinesRef.current = lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => {
          const clean = line.trim()

          // 🔥 ONLY extrusion moves (actual printing)
          return clean.startsWith("G1") && /E-?\d+(\.\d+)?/.test(clean)
        })
        .map(({ idx }) => idx)

      // =============================
      // 🔥 INITIAL WINDOW (10 LINES)
      // =============================
      setWindowStart(0)
      setGcodeLines(lines.slice(0, WINDOW_SIZE))

      // =============================
      // 🔥 FIND FIRST PRINT LINE
      // =============================
      const firstPrintIdx = executableLinesRef.current[0] ?? 0
      setStartLine(firstPrintIdx)

      } finally {
        // 🟢 CACHE: release the dedupe lock so a later refresh/Refresh-button
        // press can re-fetch this file.
        loadingFileRef.current = null
      }

    } catch (e) {
      console.error("GCODE ERROR:", e)
    }
  }

  const [fullscreen, setFullscreen] = useState(false)
  const prevSelectedFileRef = useRef("")

  // 🟢 PREVIEW: restore last selected file on page refresh
  useEffect(() => {
    const saved = localStorage.getItem("fdm_selected_file")
    if (saved) setSelectedFile(saved)
  }, [])

  // 🟠 BED ALERT: on mount, re-check bed status so a browser refresh doesn't
  // lose an active "print not removed" alert. Runs one live check on the server.
  useEffect(() => {
    fetch("http://localhost:8000/bed-status")
      .then(r => r.json())
      .then(d => { if (d.success && d.print_present) setBedAlert(true) })
      .catch(() => {})
  }, [])

  // 💡 LIGHT: sync the button with the printer's real light state on mount.
  useEffect(() => {
    fetch("http://localhost:8000/light-status")
      .then(r => r.json())
      .then(d => { if (typeof d.on === "boolean") setLightOn(d.on) })
      .catch(() => {})
  }, [])

useEffect(() => {
  fetchFiles()

  let isMounted = true
  let reconnectTimeout: any = null

  const connect = () => {
    if (!isMounted) return

    const socket = new WebSocket("ws://localhost:8000/ws/printer")
    socketRef.current = socket

    socket.onopen = () => {
      console.log("FDM connected")
    }

    socket.onmessage = (event) => {
      if (!isMounted) return

      try {
        const data = JSON.parse(event.data)

        // 🟠 BED ALERT: these events carry no telemetry payload — handle and
        // return BEFORE the code below reads moonraker_connected (which would
        // otherwise flip the UI to "disconnected").
        if (data.event === "bed_status") {
          if (data.bed_status === "Print Not Removed") setBedAlert(true)
          else if (data.bed_status === "Bed Empty") setBedAlert(false)
          return
        }

        if (data.active_file && gcodeRef.current.length === 0) {
          fetchGcode(data.active_file)
        }
        const isConnected = data.moonraker_connected ?? false

        setConnected(isConnected)

        if (typeof onConnectionChange === "function") {
          onConnectionChange(isConnected)
        }

        setStatus(data.ui_state ?? "Idle")
        const uiState = data.ui_state ?? "Idle"
        setStatus(uiState)

        // 🟢 PREVIEW: only clear when a print actually ENDS (was printing/paused → idle)
        const wasActive =
          prevUiStateRef.current === "Printing" || prevUiStateRef.current === "Paused"

        if (wasActive && (uiState === "Idle" || uiState === "Stopped") && data.active_file === "") {
          setSelectedFile("")
          gcodeRef.current = []
          setGcodeLines([])
          setCurrentLine(0)
          hasLoadedRef.current = false
          setModel3d(null)
          localStorage.removeItem("fdm_selected_file")
        }
        prevUiStateRef.current = uiState

        const s = data.raw_status
        if (!s) return

        const activeFile = data.active_file || data.raw_status?.print_stats?.filename || ""
        if (activeFile) {
          setSelectedFile(prev => {
            if (prev !== activeFile) {
              prevSelectedFileRef.current = ""
              hasLoadedRef.current = false

              fetchGcode(activeFile)
              localStorage.setItem("fdm_selected_file", activeFile)

              return activeFile
            }
            return prev
          })
        }


        setNozzleTemp(s.extruder?.temperature ?? 0)
        setNozzleTarget(s.extruder?.target ?? 0)
        setBedTemp(s.heater_bed?.temperature ?? 0)
        setBedTarget(s.heater_bed?.target ?? 0)

        setX(s.toolhead?.position?.[0] ?? 0)
        setY(s.toolhead?.position?.[1] ?? 0)
        setZ(s.toolhead?.position?.[2] ?? 0)

        // 💡 LIGHT: keep the button in sync if the pin state is reported.
        const pinVal = s["output_pin caselight"]?.value
        if (typeof pinVal === "number") setLightOn(pinVal > 0)

        const progressPct = (s.virtual_sdcard?.progress ?? 0) * 100
        setProgress(progressPct)

        // 🟢 CACHE: stash last-known telemetry so a refresh can paint instantly.
        try {
          localStorage.setItem(SNAP_KEY, JSON.stringify({
            status: uiState,
            progress: progressPct,
            nozzleTemp: s.extruder?.temperature ?? 0,
            nozzleTarget: s.extruder?.target ?? 0,
            bedTemp: s.heater_bed?.temperature ?? 0,
            bedTarget: s.heater_bed?.target ?? 0,
            x: s.toolhead?.position?.[0] ?? 0,
            y: s.toolhead?.position?.[1] ?? 0,
            z: s.toolhead?.position?.[2] ?? 0,
            ts: Date.now(),
          } as FdmSnapshot))
        } catch {
          /* quota — ignore */
        }

        const isPrinting = data.ui_state === "Printing" || data.ui_state === "Paused"

        onSummary?.({
          status: isConnected
            ? isPrinting
              ? "running"
              : uiState === "Fault"
              ? "fault"
              : "idle"
            : "offline",
          progress: isPrinting ? progressPct : null,
          temps: [
            { label: "Nozzle", value: s.extruder?.temperature ?? null },
            { label: "Bed", value: s.heater_bed?.temperature ?? null },
          ],
        })

        const speed = (s.gcode_move?.speed ?? 0) / 60
        const filteredSpeed = speed < 5 ? 0 : speed

        setMotionData(prev => {
          const newPoint = {
            time: prev.length > 0 ? prev[prev.length - 1].time + 1 : 0,

            // 🔥 USE FILTERED SPEED HERE
            feed: isPrinting ? filteredSpeed : 0,

            velocity: isPrinting ? (s.motion_report?.live_velocity ?? 0) : 0
          }

          return [...prev, newPoint].slice(-50)
        })
        // =============================
        // 🔥 EXACT LIVE TRACKING (USING REAL PRINT LINES)
        // =============================
        const pos = data.raw_status?.virtual_sdcard?.file_position ?? 0
        const total = data.raw_status?.virtual_sdcard?.file_size ?? 1

        const execLines = executableLinesRef.current
        const lines = gcodeRef.current

        if (execLines.length > 0 && total > 0) {
          const ratio = pos / total

          // 🔥 map ONLY real printing lines
          const execIndex = Math.min(
            execLines.length - 1,
            Math.floor(ratio * execLines.length)
          )

          let line = execLines[execIndex] ?? 0

          // 🔥 safety clamp
          if (line < 0) line = 0
          if (line >= lines.length) line = lines.length - 1

          // 🔥 update ONLY if changed
          if (line !== lastLineRef.current) {
            lastLineRef.current = line

            // 🔥 ALWAYS UPDATE UI (NO BLOCKING)
            setCurrentLine(line)

            const start = Math.max(0, line)
            const end = start + WINDOW_SIZE

            setWindowStart(start)
            setGcodeLines(lines.slice(start, end))
          }
        }
      } catch (err) {
        console.error("WS error:", err)
      }
    }

    socket.onclose = () => {
      if (!isMounted) return

      console.log("FDM disconnected")

      setConnected(false)

      if (typeof onConnectionChange === "function") {
        onConnectionChange(false)
      }

      reconnectTimeout = setTimeout(() => {
        connect()
      }, 2000)
    }
  }

  connect()

  return () => {
    isMounted = false

    if (socketRef.current) {
      socketRef.current.close()
    }

    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
    }
  }

}, [])

// =============================
// 🔥 CHECK RUNNING PRINT ON LOAD (FINAL FIXED)
// =============================
useEffect(() => {
  const checkRunning = async () => {
    try {
      const res = await fetch("http://localhost:8000/printer/status")
      if (!res.ok) return

      const data = await res.json()

      // 🔥 handle BOTH printing + paused
      if (data.filename) {
        console.log("Recovered running file:", data.filename)

        // 🔥 force reload cleanly
        prevSelectedFileRef.current = ""
        hasLoadedRef.current = false

        setSelectedFile(data.filename)
        localStorage.setItem("fdm_selected_file", data.filename)

        // 🔥 load gcode
        await fetchGcode(data.filename)

        // =============================
        // 🔥 RESTORE CURRENT LINE (FIXED)
        // =============================
        const pos = data.file_position ?? 0
        const lines = gcodeRef.current

        if (lines.length > 0) {
          const totalChars = lines.join("\n").length

          if (totalChars > 0) {
            const ratio = pos / totalChars

            let line = Math.floor(ratio * lines.length)

            // 🔥 safety clamp
            if (line < 0) line = 0
            if (line >= lines.length) line = lines.length - 1

            setCurrentLine(line)

            const start = Math.max(0, line - 25)
            setWindowStart(start)
            setGcodeLines(lines.slice(start, start + WINDOW_SIZE))
          }
        }
      }

    } catch (err) {
      console.error("Status check failed:", err)
    }
  }

  checkRunning()
}, [])

useEffect(() => {
  if (!selectedFile) return

  // 🔥 allow reload after refresh
  if (selectedFile === prevSelectedFileRef.current && gcodeRef.current.length > 0) return

  prevSelectedFileRef.current = selectedFile
  hasLoadedRef.current = true

  fetchGcode(selectedFile)
  const el = containerRef.current?.querySelector(".active-line")
  el?.scrollIntoView({
    block: "center",
    behavior: "smooth"
  })
}, [selectedFile])

  // =============================
  // ACTIONS
  // =============================
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!connected) return

    const file = e.target.files?.[0]
    if (!file) return

    const formData = new FormData()
    formData.append("file", file)

    const res = await fetch("http://localhost:8000/upload", {
      method: "POST",
      body: formData,
    })

    if (res.ok) {
      setUploadMessage("Upload successful ✓")
      setTimeout(() => setUploadMessage(""), 3000)

      fetchFiles()

      // ✅ ADD THIS
      setSelectedFile(file.name)
      localStorage.setItem("fdm_selected_file", file.name)
    }
  }

  // 💡 LIGHT: optimistic toggle; revert if the request fails.
  const toggleLight = async () => {
    const next = !lightOn
    setLightOn(next)
    try {
      const res = await fetch(`http://localhost:8000/light?on=${next}`, { method: "POST" })
      if (!res.ok) setLightOn(!next)
    } catch {
      setLightOn(!next)
    }
  }

  // 🔥 Buttons now OPEN the in-UI confirm dialog instead of window.confirm.
  const requestStart = () => {
    if (!connected) return
    if (!selectedFile) {
      setActionMessage("Please select a file")
      setTimeout(() => setActionMessage(""), 3000)
      return
    }
    setConfirmAction("start")
  }

  const requestPause = () => {
    if (!connected) return
    setConfirmAction("pause")
  }

  const requestStop = () => {
    if (!connected) return
    setConfirmAction("stop")
  }

  // 🔥 The actual API calls — run only after the dialog is confirmed.
  const doStart = async () => {
    const res = await fetch(`http://localhost:8000/start?filename=${encodeURIComponent(selectedFile)}`, {
      method: "POST",
    })

    if (res.ok) {
      setActionMessage("Print Started ✓")
      setTimeout(() => setActionMessage(""), 3000)
    }
  }

  const doPause = async () => {
    const res = await fetch("http://localhost:8000/pause", {
      method: "POST",
    })

    if (res.ok) {
      setActionMessage("Print Paused ✓")
      setTimeout(() => setActionMessage(""), 3000)
    }
  }

  const doStop = async () => {
    const res = await fetch("http://localhost:8000/stop", {
      method: "POST",
    })

    if (res.ok) {
      setActionMessage("Print Stopped ✓")

      // 🔥 immediate UI reset (no wait for WS)
      setSelectedFile("")
      gcodeRef.current = []
      setGcodeLines([])
      setCurrentLine(0)
      hasLoadedRef.current = false
      setModel3d(null) // 🟢 PREVIEW: clear the model too
      localStorage.removeItem("fdm_selected_file")

      setTimeout(() => setActionMessage(""), 3000)
    }
  }

  // 🔥 One shared dialog config, keyed by the pending action.
  const CONFIRM_META = {
    start: {
      title: "Start print?",
      message: "This will begin printing the selected file.",
      label: "Start",
      run: doStart,
    },
    pause: {
      title: "Pause print?",
      message: "The print will pause and can be resumed later.",
      label: "Pause",
      run: doPause,
    },
    stop: {
      title: "Stop print?",
      message: "This cancels the current print and can’t be undone.",
      label: "Stop",
      run: doStop,
    },
  } as const

  // 🟢 PREVIEW: manually re-fetch + re-parse the current file
  const handleRefreshModel = () => {
    if (!selectedFile) return
    fetchGcode(selectedFile)
  }

  const ip = import.meta.env.VITE_PRINTER_IP || "10.106.99.97"
  console.log("[FDM] Using printer IP:", ip)

return (
  <div className="relative h-[calc(100vh-64px)] p-3 grid grid-cols-[2fr_3fr] gap-2">

    {/* 🟠 BED ALERT: full-width banner across both columns when a finished
        print is still on the bed. Auto-dismisses when the bed is cleared. */}
    {bedAlert && (
      <div className="col-span-2">
        <BedAlert
          visible
          filename={selectedFile}
          onAcknowledge={() => setBedAlert(false)}
          onDismiss={() => setBedAlert(false)}
        />
      </div>
    )}

    {/* 🟢 SPINNER: backend lost the printer — show a centered loader. The grace
        gate keeps it from flashing on a normal refresh. */}
    {!connected && graceOver && <ConnectionOverlay message="Waiting for connection" />}

    {/* LEFT COLUMN */}
    <div className="flex flex-col gap-4 min-w-0">

      {/* CONTROLS */}
      <div className="bg-slate-800/5 p-4 flex flex-col gap-4 rounded border border-slate-700">
        <div className="flex justify-between items-start gap-3">
          <div>
            <p className="text-xl">Status: <span className="text-green-400 font-semibold">{status}</span></p>
            <p className="text-xl">Progress: {progress.toFixed(2)}%</p>
            {actionMessage && <p className="text-green-400 text-sm mt-1">{actionMessage}</p>}
          </div>

          {/* 💡 LIGHT: on/off toggle, top-right of the status box */}
          <button
            onClick={toggleLight}
            title={lightOn ? "Turn light off" : "Turn light on"}
            className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border transition-colors ${
              lightOn
                ? "bg-yellow-400/20 border-yellow-400 text-yellow-300"
                : "bg-slate-800 border-slate-600 text-slate-400 hover:text-slate-200"
            }`}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18h6M10 22h4" />
              <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
            </svg>
            {lightOn ? "On" : "Off"}
          </button>
        </div>

        <div className="relative w-full">
          <div
            className="bg-slate-800 p-2 rounded cursor-pointer"
            onClick={() => setOpen(prev => !prev)}
          >
            {selectedFile || "Select file..."}
          </div>

          {open && (
            <div className="absolute z-50 mt-1 w-full bg-slate-800 border border-slate-700 rounded max-h-[150px] overflow-y-auto">
              {printerFiles.map((f, i) => (
                <div
                  key={i}
                  onClick={() => {
                    setSelectedFile(f)
                    localStorage.setItem("fdm_selected_file", f)
                    setOpen(false)
                  }}
                  className="px-2 py-1 hover:bg-slate-700 cursor-pointer text-sm"
                >
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>

        <input
          type="file"
          onChange={handleUpload}
          className="bg-slate-800 p-2 rounded w-full"
        />
        {uploadMessage && <p className="text-green-400 text-xl mt-1">{uploadMessage}</p>}

        <div className="flex gap-2">
          <button onClick={requestStart} disabled={status === "Printing"} className="flex-1 bg-green-600 p-2 rounded" >▶</button>
          <button onClick={requestPause} className="flex-1 bg-yellow-500 p-2 rounded">⏸</button>
          <button onClick={requestStop} className="flex-1 bg-red-600 p-2 rounded">■</button>
        </div>
      </div>

      {/* VIDEO */}
      <div className="bg-black flex-1 rounded border border-slate-700 overflow-hidden min-h-[300px] relative">
        <img
          src={`http://${ip}:8080/?action=stream`}
          className="w-full h-full object-cover cursor-pointer"
          onClick={() => setFullscreen(true)}
          onLoad={() => console.log(`[FDM VIDEO] ✅ Stream connected to ${ip}:8080`)}
          onError={() => console.log(`[FDM VIDEO] ❌ Failed to load stream from ${ip}:8080`)}
        />
      </div>

    </div>

    {/* RIGHT COLUMN */}
    <div className="flex flex-col gap-4 min-w-0 overflow-y-auto">

      {/* TOP: XYZ + GAUGES */}
      <div className="flex gap-3 flex-wrap">
        {[{label:"X",value:x},{label:"Y",value:y},{label:"Z",value:z}].map(axis => (
          <div key={axis.label} className="bg-slate-800/5 p-3 flex-1 w-[50px] rounded border border-slate-700 flex flex-col justify-center items-center">
            <p className="text-lg font-semibold text-slate-300">{axis.label}</p>
            <p className="text-2xl font-bold text-green-400">{axis.value.toFixed(2)}</p>
          </div>
        ))}
        <div className="bg-slate-800/5 p-3 flex-1 min-w-[200px] rounded border border-slate-700">
          <p>Nozzle</p>
          <div className="flex gap-3 items-center">
            <SemiGauge value={nozzleTemp} max={300} color="#ee810d" />
            <div>
              <p>{nozzleTemp.toFixed(1)}°C</p>
              <p className="text-xs text-slate-400">Target: {nozzleTarget}</p>
            </div>
          </div>
        </div>

        <div className="bg-slate-800/5 p-3 flex-1 min-w-[200px] rounded border border-slate-700">
          <p>Bed</p>
          <div className="flex gap-3 items-center">
            <SemiGauge value={bedTemp} max={120} color="#3b82f6" />
            <div>
              <p>{bedTemp.toFixed(1)}°C</p>
              <p className="text-xs text-slate-400">Target: {bedTarget}</p>
            </div>
          </div>
        </div>
      </div>

      {/* FEED */}
      <div className="bg-slate-800/5 p-4 rounded border border-slate-700 w-full h-[180px]">
        <h3 className="mb-2">Feed Rate</h3>
        <ResponsiveContainer width="100%" height="85%">
          <LineChart data={motionData}>
            <CartesianGrid stroke="#1e293b" vertical={false} />
            <XAxis dataKey="time" stroke="#94a3b8" tickFormatter={() => ""} domain={['dataMin', 'dataMax']} />
            <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155" }} />
            <Line type="monotone" dataKey="feed" stroke="#a855f7" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* VELOCITY */}
      <div className="bg-slate-800/5 p-4 rounded border border-slate-700 w-full h-[180px]">
        <h3 className="mb-2">Velocity</h3>
        <ResponsiveContainer width="100%" height="85%">
          <LineChart data={motionData}>
            <CartesianGrid stroke="#334155" vertical={false}/>
            <XAxis dataKey="time" tickFormatter={() => ""} />
            <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155" }} />
            <Line type="monotone" dataKey="velocity" stroke="#71f441" strokeWidth={2}  dot={false} isAnimationActive={false}  />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* FILE LABEL */}
      <p className="text-xs font-semibold text-slate-400 -mb-2">
        File: {selectedFile || "None"}
      </p>

      {/* 🟢 3D PRINT PREVIEW */}
      <div className="bg-[#0d1117] rounded border border-slate-700 w-full h-[500px] overflow-hidden flex flex-col">
        {/* header */}
        <div className="sticky top-0 bg-[#0d1117] px-4 py-2 border-b border-slate-700">
          <div className="flex justify-between items-center">
            <h3 className="text-slate-300 text-sm font-semibold">Print Preview</h3>
            <div className="flex items-center gap-3">
              <button
                onClick={handleRefreshModel}
                disabled={!selectedFile}
                title="Reload model"
                className="text-slate-400 hover:text-slate-200 disabled:opacity-40 text-sm"
              >
                ⟳ Refresh
              </button>
              <span className="text-green-400 text-sm font-semibold">{progress.toFixed(0)}%</span>
            </div>
          </div>

          {/* toolbar: color mode + travels */}
          <div className="flex items-center gap-2 mt-2 text-xs">
            <div className="flex rounded overflow-hidden border border-slate-700">
              {(["progress", "feature", "speed"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setColorMode(m)}
                  className={`px-2 py-1 capitalize ${
                    colorMode === m ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowTravel(v => !v)}
              className={`px-2 py-1 rounded border border-slate-700 ${
                showTravel ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800"
              }`}
            >
              Travels
            </button>
          </div>
        </div>

        {/* canvas + overlays */}
        <div className="flex-1 relative">
          <PrintPreview3D
            model={model3d}
            progress={progress}
            buildVolume={BUILD_VOLUME}
            toolhead={connected ? { x, y, z } : null}
            colorMode={colorMode}
            showTravel={showTravel}
            printedColor="#4ade80"
            skeletonColor="#e2e8f0"
          />

          {/* HUD */}
          <div className="absolute top-2 left-2 bg-[#0f172a]/85 border border-slate-700 rounded px-3 py-2 text-xs text-slate-300 pointer-events-none leading-5">
            <div>Z <span className="text-green-400">{z.toFixed(2)} mm</span></div>
            <div>Nozzle <span className="text-orange-400">{nozzleTemp.toFixed(0)}°C</span></div>
            <div>Bed <span className="text-blue-400">{bedTemp.toFixed(0)}°C</span></div>
          </div>

          {/* feature legend */}
          {colorMode === "feature" && (
            <div className="absolute bottom-2 left-2 bg-[#0f172a]/85 border border-slate-700 rounded px-3 py-2 text-xs text-slate-300 pointer-events-none flex flex-col gap-1">
              {FEATURE_LEGEND.map(([c, l]) => (
                <div key={l} className="flex items-center gap-2">
                  <span style={{ background: c }} className="inline-block w-3 h-1 rounded" />
                  {l}
                </div>
              ))}
            </div>
          )}

          {/* speed legend */}
          {colorMode === "speed" && (
            <div className="absolute bottom-2 left-2 bg-[#0f172a]/85 border border-slate-700 rounded px-3 py-2 text-xs text-slate-300 pointer-events-none">
              <div className="flex items-center gap-2">
                <span className="text-blue-400">slow</span>
                <span
                  className="inline-block w-16 h-1 rounded"
                  style={{ background: "linear-gradient(to right,#2680f0,#ef4444)" }}
                />
                <span className="text-red-400">fast</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 🟢 OLD G-CODE TEXT VIEWER — kept for reference, disabled.
          Flip SHOW_GCODE_VIEWER (top of component) to true to bring it back. */}
      {SHOW_GCODE_VIEWER && (
        <div ref={containerRef} className="bg-[#0d1117] rounded border border-slate-700 w-full h-[500px] overflow-y-auto">
          <div className="sticky top-0 bg-[#0d1117] px-4 py-2 border-b border-slate-700">
            <h3 className="text-slate-300 text-sm font-semibold">G-Code</h3>
          </div>
          <div className="text-sm font-mono">
            {gcodeLines.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-slate-500">
                No G-code loaded
              </div>
            ) : (
              gcodeLines.map((line, i) => {
                const globalIndex = windowStart + i
                const isActive = globalIndex === currentLine
                const commentIdx = line.indexOf(";")
                const code = commentIdx >= 0 ? line.substring(0, commentIdx) : line
                const comment = commentIdx >= 0 ? line.substring(commentIdx) : ""

                const tokens = code.split(" ").filter(Boolean).map((token, ti) => {
                  if (/^[GM]\d+$/i.test(token)) {
                    return <span key={ti} className="text-[#56b6c2]">{token} </span>
                  }
                  if (/^[A-Z]-?\d+(\.\d+)?$/i.test(token)) {
                    const letter = token[0].toUpperCase()
                    const value = token.slice(1)
                    const colors: Record<string, string> = {
                      X: "#e06c75", Y: "#e06c75", Z: "#e06c75",
                      E: "#d19a66", F: "#c678dd", S: "#98c379", T: "#61afef"
                    }
                    return (
                      <span key={ti}>
                        <span className="text-[#abb2bf]">{letter}</span>
                        <span style={{ color: colors[letter] || "#abb2bf" }}>{value} </span>
                      </span>
                    )
                  }
                  return <span key={ti} className="text-slate-400">{token} </span>
                })

                return (
                  <div
                    key={i}
                    className={`flex px-2 py-[2px] border-b border-slate-800 ${
                      isActive
                        ? "bg-cyan-500/20 text-cyan-300 font-semibold active-line"
                        : "hover:bg-slate-800/40"
                    }`}
                  >
                    {/* 🔥 LINE NUMBER COLUMN */}
                    <div
                      className={`w-12 pr-2 text-right border-r border-slate-800 ${
                        isActive ? "text-cyan-400" : "text-slate-500"
                      }`}
                    >
                      {windowStart + i + 1}
                    </div>

                    {/* 🔥 GCODE COLUMN */}
                    <div className="pl-2 flex-1 font-mono">
                      {line.trim() === "" ? (
                        <span>&nbsp;</span>
                      ) : (
                        <>
                          {tokens}
                          {comment && (
                            <span className="text-slate-500 italic">{comment}</span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

    </div>

    {/* 🔥 IN-UI CONFIRM DIALOG (replaces window.confirm) */}
    {confirmAction && (
      <ConfirmDialog
        open
        title={CONFIRM_META[confirmAction].title}
        message={CONFIRM_META[confirmAction].message}
        confirmLabel={CONFIRM_META[confirmAction].label}
        onConfirm={() => {
          const action = confirmAction
          setConfirmAction(null)
          CONFIRM_META[action].run()
        }}
        onCancel={() => setConfirmAction(null)}
      />
    )}

    {/* 🔥 FULLSCREEN POPUP */}
    {fullscreen && (
      <div
        className="fixed inset-0 bg-black z-50 flex items-center justify-center cursor-pointer"
        onClick={() => setFullscreen(false)}
      >
        <button
          className="absolute top-4 right-4 text-white text-3xl z-50 hover:text-gray-400"
          onClick={() => setFullscreen(false)}
        >
          ✕
        </button>
        <img
          src={`http://${ip}:8080/?action=stream`}
          className="w-full h-full object-contain"
        />
      </div>
    )}

  </div>
)
}
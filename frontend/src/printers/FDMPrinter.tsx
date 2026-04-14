import { useEffect, useState, useRef } from "react"
import SemiGauge from "../components/SemiGauge"

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer
} from "recharts"

export default function FDM({ onConnectionChange }: { onConnectionChange?: (v: boolean) => void }) {

  const [connected, setConnected] = useState(false)

  const [status, setStatus] = useState("Idle")
  const [progress, setProgress] = useState(0)

  const [nozzleTemp, setNozzleTemp] = useState(0)
  const [nozzleTarget, setNozzleTarget] = useState(0)
  const [bedTemp, setBedTemp] = useState(0)
  const [bedTarget, setBedTarget] = useState(0)

  const [x, setX] = useState(0)
  const [y, setY] = useState(0)
  const [z, setZ] = useState(0)

  const [uploadMessage, setUploadMessage] = useState("")
  const [actionMessage, setActionMessage] = useState("")

  const [printerFiles, setPrinterFiles] = useState<string[]>([])
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
  const WINDOW_SIZE = 10
  const hasLoadedRef = useRef(false)
  const lastLineRef = useRef(-1)
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

      const res = await fetch(`http://localhost:8000/gcode?file=${cleanFile}`)
      if (!res.ok) return

      let text = await res.text()
      if (!text || text.length < 10) return

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
      setGcodeLines(lines.slice(0, 10))

      // =============================
      // 🔥 FIND FIRST PRINT LINE
      // =============================
      const firstPrintIdx = executableLinesRef.current[0] ?? 0
      setStartLine(firstPrintIdx)

    } catch (e) {
      console.error("GCODE ERROR:", e)
    }
  }

  const [fullscreen, setFullscreen] = useState(false)
  const prevSelectedFileRef = useRef("")

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

        // 🔥 FIX: when stopped → clear active file state
        if ((uiState === "Idle" || uiState === "Stopped") && data.active_file === "") {
          setSelectedFile("")
          gcodeRef.current = []
          setGcodeLines([])
          setCurrentLine(0)
          hasLoadedRef.current = false
        }

        const s = data.raw_status
        if (!s) return

        const activeFile = data.active_file || data.raw_status?.print_stats?.filename || ""
        if (activeFile) {
          setSelectedFile(prev => {
            if (prev !== activeFile) {
              prevSelectedFileRef.current = ""
              hasLoadedRef.current = false

              fetchGcode(activeFile)

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

        setProgress((s.virtual_sdcard?.progress ?? 0) * 100)

        setMotionData(prev => [
            ...prev,
            {
            time: prev.length > 0 ? prev[prev.length - 1].time + 1 : 0,
            feed: (s.gcode_move?.speed ?? 0) / 60,
            velocity: s.motion_report?.live_velocity ?? 0
            }
          ].slice(-50))
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

            setCurrentLine(line)

            setGcodeLines(prev => {
              // first load
              if (prev.length === 0) {
                setWindowStart(line)
                return lines.slice(line, line + WINDOW_SIZE)
              }

              // 🔥 shift window only when needed
              if (line >= windowStart + WINDOW_SIZE - 1) {
                const newStart = windowStart + 1
                setWindowStart(newStart)
                return lines.slice(newStart, newStart + WINDOW_SIZE)
              }

              return prev
            })
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
  // ACTIONS (UNCHANGED)
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
    }
  }

  const handleStart = async () => {
    if (!connected) return
    if (!selectedFile) return alert("Please select a file")
    if (!window.confirm("Start print?")) return

    const res = await fetch(`http://localhost:8000/start?filename=${encodeURIComponent(selectedFile)}`, {
      method: "POST",
    })

    if (res.ok) {
      setActionMessage("Print Started ✓")
      setTimeout(() => setActionMessage(""), 3000)
    }
  }

  const handlePause = async () => {
    if (!connected) return
    if (!window.confirm("Pause print?")) return

    const res = await fetch("http://localhost:8000/pause", {
      method: "POST",
    })

    if (res.ok) {
      setActionMessage("Print Paused ✓")
      setTimeout(() => setActionMessage(""), 3000)
    }
  }

  const handleStop = async () => {
    if (!connected) return
    if (!window.confirm("Stop print?")) return

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

      setTimeout(() => setActionMessage(""), 3000)
    }
  }
  const ip = import.meta.env.VITE_PRINTER_IP

return (
  <div className="h-[calc(100vh-64px)] p-3 grid grid-cols-[2fr_3fr] gap-2">

    {!connected && (
      <div className="absolute top-0 left-0 w-full text-white text-center py-1 font-semibold z-200">
        ⚠️ FDM Disconnected
      </div>
    )}

    {/* LEFT COLUMN */}
    <div className="flex flex-col gap-4 min-w-0">

      {/* CONTROLS */}
      <div className="bg-slate-800/5 p-4 flex flex-col gap-4 rounded border border-slate-700">
        <div>
          <p className="text-xl">Status: <span className="text-green-400 font-semibold">{status}</span></p>
          <p className="text-xl">Progress: {progress.toFixed(2)}%</p>
          {actionMessage && <p className="text-green-400 text-sm mt-1">{actionMessage}</p>}
        </div>

        <select
          value={selectedFile}
          onChange={(e) => setSelectedFile(e.target.value)}
          disabled={status === "Printing"}   // 🔥 ADD
          className="bg-slate-800 p-2 rounded w-full"
        >
          <option value="">Select file...</option>
          {printerFiles.map((f, i) => <option key={i}>{f}</option>)}
        </select>

        <input
          type="file"
          onChange={handleUpload}
          className="bg-slate-800 p-2 rounded w-full"
        />
        {uploadMessage && <p className="text-green-400 text-xl mt-1">{uploadMessage}</p>}

        <div className="flex gap-2">
          <button onClick={handleStart} disabled={status === "Printing"} className="flex-1 bg-green-600 p-2 rounded" >▶</button>
          <button onClick={handlePause} className="flex-1 bg-yellow-500 p-2 rounded">⏸</button>
          <button onClick={handleStop} className="flex-1 bg-red-600 p-2 rounded">■</button>
        </div>
      </div>

      {/* VIDEO */}
      <div className="bg-black flex-1 rounded border border-slate-700 overflow-hidden min-h-[300px]">
        {connected ? (
          <img
            src={`http://${ip}:8080/?action=stream`}
            className="w-full h-full object-cover cursor-pointer"
            onClick={() => setFullscreen(true)}   // 🔥 CLICK
          />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-500">
            Live Streaming Video
          </div>
        )}
      </div>

    </div>

    {/* RIGHT COLUMN */}
    <div className="flex flex-col gap-4 min-w-0 overflow-y-auto">

      {/* TOP: XYZ + GAUGES */}
      <div className="flex gap-3 flex-wrap">
        {[{label:"X",value:x},{label:"Y",value:y},{label:"Z",value:z}].map(axis => (
          <div key={axis.label} className="bg-slate-800/5 p-3 flex-1 w-[50px] rounded border border-slate-700 flex flex-col justify-center">
            <p>{axis.label}</p>
            <p className="text-green-400">{axis.value.toFixed(2)}</p>
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
            <XAxis dataKey="time" stroke="#94a3b8" tick={{ fontSize: 10 }} domain={['dataMin', 'dataMax']} />
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
            <CartesianGrid stroke="#334155" />
            <XAxis dataKey="time" />
            <YAxis />
            <Tooltip />
            <Line dataKey="velocity" stroke="#08eb5c" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* GCODE VIEWER */}
      <p className="text-xs text-slate-400 -mb-2">
        File: {selectedFile || "None"}
      </p>
      <div ref={containerRef} className="bg-[#0d1117] rounded border border-slate-700 w-full h-[280px] overflow-y-auto">
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
                  className={`flex gap-2 px-2 py-[1px] border-l-2 ${
                    isActive
                      ? "bg-cyan-500/20 border-cyan-400 text-cyan-300 font-semibold active-line"
                      : "border-transparent hover:bg-slate-800/40"
                  }`}
                >
                  <span className={`select-none w-8 text-right shrink-0 text-xs pt-[1px] ${
                    isActive ? "text-cyan-400" : "text-slate-600"
                  }`}>
                    {i + 1}
                  </span>
                  <span>
                    {line.trim() === "" ? <span>&nbsp;</span> : <>{tokens}{comment && <span className="text-slate-500 italic">{comment}</span>}</>}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>

    </div>
    {/* 🔥 FULLSCREEN POPUP */}
    {fullscreen && (
      <div
        className="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
        onClick={() => setFullscreen(false)}
      >
        <img
          src={`http://${ip}:8080/?action=stream`}
          className="w-full h-full object-contain"
        />
      </div>
    )}

  </div>
)
}
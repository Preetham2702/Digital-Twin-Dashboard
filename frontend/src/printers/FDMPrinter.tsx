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
          const isConnected = data.moonraker_connected ?? false
  
          setConnected(isConnected)
  
          if (typeof onConnectionChange === "function") {
            onConnectionChange(isConnected)
          }
  
          setStatus(data.ui_state ?? "Idle")
  
          const s = data.raw_status
          if (!s) return
  
          setNozzleTemp(s.extruder?.temperature ?? 0)
          setNozzleTarget(s.extruder?.target ?? 0)
          setBedTemp(s.heater_bed?.temperature ?? 0)
          setBedTarget(s.heater_bed?.target ?? 0)
  
          setX(s.toolhead?.position?.[0] ?? 0)
          setY(s.toolhead?.position?.[1] ?? 0)
          setZ(s.toolhead?.position?.[2] ?? 0)
  
          setProgress((s.virtual_sdcard?.progress ?? 0) * 100)

          setMotionData(prev => {
            const newData = [
              ...prev,
              {
                time: prev.length,
                feed: (s.gcode_move?.speed ?? 0) / 60,
                velocity: s.motion_report?.live_velocity ?? 0
              }
            ]
            if (newData.length > 40) newData.shift()
            return newData
          })
  
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
  
        // 🔥 AUTO RECONNECT
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
      setTimeout(() => setActionMessage(""), 3000)
    }
  }

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden">

      {!connected && (
        <div className="absolute top-0 left-0 w-full text-white text-center py-1 font-semibold z-200">
          ⚠️ FDM Disconnected
        </div>
      )}

      {/* LEFT PANEL */}
      <div className="w-1/4 bg-slate-800 border-r border-slate-700 p-6 flex flex-col gap-6">

        <div>
        <p className="text-base md:text-lg lg:text-xl font-medium">
          Status: <span className="text-green-400 font-semibold">{status}</span>
        </p>

        <p className="text-base md:text-lg lg:text-xl">
          Progress: {progress.toFixed(1)}%
        </p>
          {actionMessage && (
            <p className="text-green-400 text-sm mt-1">{actionMessage}</p>
          )}
        </div>

        {/* ✅ EXISTING FILES */}
        <div>
          <label className="text-base md:text-lg font-medium text-slate-300">
            Existing Printer Files
          </label>

          <select
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
            className="w-full text-base md:text-lg bg-slate-700 p-3 rounded border border-slate-600 mt-2"
          >
            <option value="">Select file...</option>

            {printerFiles.length === 0 ? (
              <option disabled>No files found</option>
            ) : (
              printerFiles.map((file, index) => (
                <option key={index} value={file}>
                  {file}
                </option>
              ))
            )}
          </select>
        </div>

        {/* Upload Section (unchanged styling) */}
        <div>
          <label className="text-base md:text-lg font-medium text-slate-300">G-Code File</label>
          <input
            type="file"
            onChange={handleUpload}
            className="w-full text-base md:text-lg bg-slate-700 p-3 rounded border border-slate-600 cursor-pointer"
          />
          {uploadMessage && (
            <p className="text-green-400 text-xs mt-1">{uploadMessage}</p>
          )}
        </div>

        <div className="flex gap-4">
          <button onClick={handleStart} className="flex-1 bg-green-600 hover:bg-green-700 rounded p-2">▶</button>
          <button onClick={handlePause} className="flex-1 bg-yellow-500 hover:bg-yellow-600 rounded p-2 text-black">⏸</button>
          <button onClick={handleStop} className="flex-1 bg-red-600 hover:bg-red-700 rounded p-2">■</button>
        </div>

        <div className="flex-1 bg-black border border-slate-600 rounded overflow-hidden">
          {connected ? (
            <img
              src="http://localhost:8000/video_feed"
              className="w-full h-full object-cover"
              alt="Live Stream"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500">
              Live Streaming Video
            </div>
          )}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 pt-12 px-6 pb-6 flex flex-col gap-6 h-full overflow-y-auto">

        {/* ROW 1 - X Y Z */}
        <div className="flex gap-6">
          {[{label:"X",value:x},{label:"Y",value:y},{label:"Z",value:z}].map(axis => (
            <div
              key={axis.label}
              className="bg-slate-800 px-6 py-4 rounded border border-slate-700 flex-1"
            >
              <p className="text-base md:text-lg font-semibold text-slate-300">
                {axis.label} Position
              </p>
              <p className="text-2xl text-green-400">
                {axis.value.toFixed(2)} mm
              </p>
            </div>
          ))}
        </div>

        {/* ROW 2 - NOZZLE + BED */}
        <div className="flex gap-10">

          <div className="bg-slate-800 p-6 rounded border border-slate-700 flex-1">
          <h3 className="mb-4 text-lg md:text-xl font-semibold text-slate-200">
            Nozzle
          </h3>
            <div className="flex items-center gap-8">
              <SemiGauge value={nozzleTemp} max={300} color="#f97316" />
              <div>
                <p className="text-lg">Temp: {nozzleTemp.toFixed(1)}°C</p>
                <p className="text-slate-400">Target: {nozzleTarget}°C</p>
              </div>
            </div>
          </div>

          <div className="bg-slate-800 p-6 rounded border border-slate-700 flex-1">
          <h3 className="mb-4 text-lg md:text-xl font-semibold text-slate-200">
            Bed
          </h3>
            <div className="flex items-center gap-8">
              <SemiGauge value={bedTemp} max={120} color="#3b82f6" />
              <div>
                <p className="text-lg">Temp: {bedTemp.toFixed(1)}°C</p>
                <p className="text-slate-400">Target: {bedTarget}°C</p>
              </div>
            </div>
          </div>

        </div>

        {/* ROW 3 - MOTION GRAPHS (SEPARATE) */}
        <div className="flex flex-col gap-6 h-[500px]">

          {/* FEED GRAPH */}
          <div className="bg-slate-800 p-4 rounded flex-1">
            <h3 className="text-lg font-semibold mb-3 text-slate-200">
              Feed Rate (mm/s)
            </h3>

            <ResponsiveContainer width="100%" height="85%">
              <LineChart data={motionData}>
                <CartesianGrid stroke="#334155" strokeDasharray="3 3" />

                <XAxis
                  dataKey="time"
                  stroke="#94a3b8"
                  label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }}
                />

                <YAxis
                  stroke="#94a3b8"
                  domain={[0, 300]}
                  ticks={[0, 100, 200, 300]}
                />

                <Tooltip />

                <Line
                  type="monotone"
                  dataKey="feed"
                  stroke="#a855f7"
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* VELOCITY GRAPH */}
          <div className="bg-slate-800 p-4 rounded flex-1">
            <h3 className="text-lg font-semibold mb-3 text-slate-200">
              Velocity (mm/s)
            </h3>

            <ResponsiveContainer width="100%" height="85%">
              <LineChart data={motionData}>
                <CartesianGrid stroke="#334155" strokeDasharray="3 3" />

                <XAxis
                  dataKey="time"
                  stroke="#94a3b8"
                  label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }}
                />

                <YAxis
                  stroke="#94a3b8"
                  domain={[0, 400]}
                  ticks={[0, 100, 200, 300, 400]}
                />

                <Tooltip />

                <Line
                  type="monotone"
                  dataKey="velocity"
                  stroke="#22c55e"
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

        </div>
      </div>
    </div>
  )
}
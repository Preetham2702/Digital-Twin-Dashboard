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

export default function FDM() {

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
  const [connectionNotice, setConnectionNotice] = useState("")

  // ✅ NEW STATES
  const [printerFiles, setPrinterFiles] = useState<string[]>([])
  const [selectedFile, setSelectedFile] = useState("")

  const startTimeRef = useRef<number | null>(null)

  const [motionData, setMotionData] = useState<
    { time: number; feed: number; velocity: number }[]
  >([])

  // =============================
  // FETCH EXISTING FILES
  // =============================
  const fetchFiles = async () => {
    try {
      const res = await fetch("http://localhost:8000/files")
      if (res.ok) {
        const data = await res.json()
        setPrinterFiles(data)
      }
    } catch (err) {
      console.error("Failed to fetch printer files")
    }
  }

  useEffect(() => {
    fetchFiles()
  }, [])

  // =============================
  // WEBSOCKET
  // =============================
  useEffect(() => {
    const socket = new WebSocket("ws://localhost:8000/ws/printer")
    let interval: any
    const previousConnectionStateRef = { current: false }
  
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data)
      const isConnected = data.moonraker_connected ?? false
  
      setConnected(isConnected)
      setStatus(data.ui_state ?? "Idle")
  
      // ✅ Show "Connected" only once
      if (isConnected && !previousConnectionStateRef.current) {
        setConnectionNotice("connected")
        setTimeout(() => setConnectionNotice(""), 2000)

        if (interval) {
          clearInterval(interval)
          interval = null
        }
      }

      // ✅ Show disconnect repeatedly
      if (!isConnected && previousConnectionStateRef.current) {
        setConnectionNotice("disconnected")

        if (!interval) {
          interval = setInterval(() => {
            setConnectionNotice("disconnected")
            setTimeout(() => setConnectionNotice(""), 2000)
          }, 4000)
        }
      }

      previousConnectionStateRef.current = isConnected
  
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
        const nowSeconds = Math.floor(Date.now() / 1000)
      
        // Set start time only once
        if (!startTimeRef.current) {
          startTimeRef.current = nowSeconds
        }
      
        const elapsed = nowSeconds - startTimeRef.current
      
        const newData = [
          ...prev,
          {
            time: elapsed,
            feed: s.gcode_move?.speed ?? 0,
            velocity: s.motion_report?.live_velocity ?? 0
          }
        ]
      
        if (newData.length > 40) newData.shift()
        return newData
      })
    }
  
    socket.onclose = () => {
      setConnected(false)
      setConnectionNotice("disconnected")
    }
  
    return () => {
      socket.close()
      if (interval) clearInterval(interval)
    }
  }, [])

  // =============================
  // ACTIONS
  // =============================
  const handleUpload = async (e: any) => {
    if (!connected) return

    const file = e.target.files[0]
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
      fetchFiles() // ✅ refresh file list after upload
    }
  }

  const handleStart = async () => {
    if (!connected) return
    if (!selectedFile) {
      alert("Please select a file")
      return
    }
    if (!window.confirm("Start print?")) return

    const res = await fetch(`http://localhost:8000/start/${selectedFile}`, {
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
    <div className="flex flex-1 overflow-hidden relative">

      {/* 🔹 Connection Notice */}
      {connectionNotice && (
        <div className="absolute top-6 right-6 bg-slate-800 px-4 py-2 rounded-md shadow-lg text-sm transition-all duration-300">
          {connectionNotice === "connected" ? (
            <span className="text-green-400">✅ Moonraker Connected</span>
          ) : (
            <span className="text-red-500">❌ Moonraker Not Connected</span>
          )}
        </div>
      )}
      {/* 🔴 Persistent Disconnect Banner */}
      {!connected && (
        <div className="absolute top-0 left-0 w-full text-white text-center py-2 font-semibold z-50">
          ⚠️ Moonraker Disconnected
        </div>
      )}

      {/* LEFT PANEL */}
      <div className="w-1/3 bg-slate-800 border-r border-slate-700 p-6 flex flex-col gap-6">

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
          <label className="text-base md:text-lg font-medium text-slate-300">Existing Printer Files</label>
          <select
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
            className="w-full text-base md:text-lg bg-slate-700 p-3 rounded border border-slate-600 mt-2"
          >
            <option value="">Select file...</option>
            {printerFiles.map((file, index) => (
              <option key={index} value={file}>
                {file}
              </option>
            ))}
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
              src="http://10.106.99.97:8080/?action=stream"
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
      <div className="flex-1 p-6 flex flex-col gap-6">

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
        <div className="flex gap-6">

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

        {/* ROW 3 - MOTION GRAPH */}
        <div className="bg-slate-800 p-6 rounded border border-slate-700 flex-1">
          <h3 className="mb-6 text-xl md:text-2xl font-semibold text-slate-200">
            Motion Analysis (Feed vs Velocity)
          </h3>

          <ResponsiveContainer width="100%" height="90%">
            <LineChart data={motionData}>
              <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                stroke="#94a3b8"
                label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }}
              />
              <YAxis stroke="#94a3b8" />
              <Tooltip />
              <Line type="monotone" dataKey="feed" stroke="#a855f7" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="velocity" stroke="#22c55e" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>

      </div>
    </div>
  )
}
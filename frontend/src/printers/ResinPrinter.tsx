import React, { useEffect, useState } from "react"
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer
} from "recharts"

export default function Resin({ onConnectionChange }: { onConnectionChange?: (v: boolean) => void }) {

  const [data, setData] = useState<{ time: number; layer: number; uvled: number; tank: number }[]>([])
  const [status, setStatus] = useState("Disconnected")
  const [progress, setProgress] = useState(0)
  const [layer, setLayer] = useState(0)
  const [totalLayers, setTotalLayers] = useState(0)
  const [zHeight, setZHeight] = useState(0)
  const [remainingMin, setRemainingMin] = useState(0)
  const [filename, setFilename] = useState("")

  const [connected, setConnected] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [previewSrc, setPreviewSrc] = useState("")
  const [cameraOk, setCameraOk] = useState(false)

  // Refresh camera snapshot every second
  useEffect(() => {
    const interval = setInterval(() => {
      setPreviewSrc(`http://localhost:8000/preview?t=${Date.now()}`)
    }, 1000)
    return () => clearInterval(interval)
  }, [])
  const [uvledTemp, setUvledTemp] = useState(0)
  const [tankTemp, setTankTemp] = useState(0)
  const [tankTarget, setTankTarget] = useState(0)
  const [heatOn, setHeatOn] = useState(false)
  const [timelapse, setTimelapse] = useState(false)
  const [filmCount, setFilmCount] = useState(0)
  const [filmMax, setFilmMax] = useState(60000)
  const [errorNum, setErrorNum] = useState(0)

  useEffect(() => {
    let isMounted = true
    const socket = new WebSocket("ws://localhost:8000/ws/resin")

    socket.onopen = () => {
      if (!isMounted) return
      setConnected(true)
    }

    socket.onmessage = (event) => {
      if (!isMounted) return
      try {
        const msg = JSON.parse(event.data)

        // Report actual printer connection to Dashboard header
        const printerUp = msg.printer_connected ?? false
        if (typeof onConnectionChange === "function") onConnectionChange(printerUp)

        setStatus(msg.status ?? "Idle")
        setLayer(msg.current_layer ?? 0)
        setTotalLayers(msg.total_layers ?? 0)
        setProgress(msg.progress ?? 0)
        setZHeight(msg.z_position_mm ?? 0)
        setRemainingMin(msg.remaining_time_min ?? 0)
        setFilename(msg.filename ?? "")

        setUvledTemp(msg.uvled_temp_c ?? 0)
        setTankTemp(msg.tank_temp_c ?? 0)
        setTankTarget(msg.tank_target_c ?? 0)
        setHeatOn(msg.heat_on ?? false)
        setTimelapse(msg.timelapse_on ?? false)
        setFilmCount(msg.release_film_count ?? 0)
        setFilmMax(msg.release_film_max ?? 60000)
        setErrorNum(msg.error_number ?? 0)

        setData(prev => [
          ...prev.slice(-40),
          {
            time: prev.length,
            layer: msg.current_layer ?? 0,
            uvled: msg.uvled_temp_c ?? 0,
            tank: msg.tank_temp_c ?? 0,
          }
        ])

      } catch (err) {
        console.error("WebSocket parse error:", err)
      }
    }

    socket.onclose = () => {
      if (!isMounted) return
      setStatus("Disconnected")
      setConnected(false)

      if (typeof onConnectionChange === "function") {
        onConnectionChange(false)
      }
    }

    return () => {
      isMounted = false
      socket.close()
    }
  }, [])

  const post = (endpoint: string) =>
    fetch(`http://localhost:8000/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    })

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append("file", file)
    await fetch("http://localhost:8000/upload", { method: "POST", body: formData })
  }

  const formatRemaining = (min: number) => {
    if (min <= 0) return "0m"
    const h = Math.floor(min / 60)
    const m = Math.round(min % 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden">

      {/* ===== LEFT PANEL ===== */}
      <div className="w-[30%] min-w-[340px] p-5 flex flex-col gap-4 border-r border-slate-700 overflow-hidden">

        <h2 className="text-lg font-semibold">Resin Machine</h2>

        <div>
          <p className="text-sm text-gray-400">Upload Print File</p>
          <input type="file" onChange={uploadFile} className="w-full mt-2 bg-slate-800 p-2 rounded" />
        </div>

        <div className="flex gap-3">
          <button onClick={() => post("start")} className="flex-1 bg-green-600 hover:bg-green-700 rounded p-2">▶</button>
          <button onClick={() => post("pause")} className="flex-1 bg-yellow-500 hover:bg-yellow-600 rounded p-2 text-black">⏸</button>
          <button onClick={() => post("stop")}  className="flex-1 bg-red-600 hover:bg-red-700 rounded p-2">■</button>
        </div>

        <div
          className="flex-1 bg-black border border-slate-600 rounded overflow-hidden cursor-pointer relative"
          onClick={() => cameraOk && setFullscreen(true)}
        >
          <img
            src={previewSrc}
            className={`w-full h-full object-cover ${cameraOk ? "" : "hidden"}`}
            onLoad={() => setCameraOk(true)}
            onError={() => setCameraOk(false)}
          />
          {!cameraOk && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              No Preview Available
            </div>
          )}
        </div>

      </div>

      {/* ===== FULLSCREEN OVERLAY ===== */}
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
            src={previewSrc}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      )}

      {/* ===== RIGHT PANEL ===== */}
      <div className="flex-1 p-4 flex flex-col gap-5 overflow-hidden">

        {/* Row 1 — Print info */}
        <div className="grid grid-cols-4 gap-2">
          <Card title="Layer">{layer} / {totalLayers}</Card>
          <Card title="Z Height">{zHeight} mm</Card>
          <Card title="Remaining">{connected ? formatRemaining(remainingMin) : "--"}</Card>
          <Card title="Status">{status} ({progress}%)</Card>
        </div>

        {/* Row 2 — Temperatures */}
        <div className="grid grid-cols-4 gap-2">
          <Card title="UV LED Temp">{connected ? `${uvledTemp} °C` : "--"}</Card>
          <Card title="Tank Temp">{connected ? `${tankTemp} °C` : "--"}</Card>
          <Card title="Tank Target">{connected ? `${tankTarget} °C` : "--"}</Card>
          <Card title="Heater">{connected ? (heatOn ? "ON" : "OFF") : "--"}</Card>
        </div>

        {/* Row 3 — Machine info */}
        <div className="grid grid-cols-4 gap-2">
          <Card title="Release Film">{connected ? `${filmCount}` : "--"}</Card>
          <Card title="Film Max">{connected ? `${filmMax}` : "--"}</Card>
          <Card title="Timelapse">{connected ? (timelapse ? "ON" : "OFF") : "--"}</Card>
          <Card title="Errors">{connected ? `${errorNum}` : "--"}</Card>
        </div>

        {/* Chart — Layer vs Time */}
        <div className="bg-slate-800 p-3 rounded flex flex-col" style={{ height: "200px" }}>
          <h3 className="text-sm mb-2">Layer vs Time</h3>
          <div className="flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <XAxis dataKey="time" hide />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="layer" stroke="#22c55e" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart — Temperature */}
        <div className="bg-slate-800 p-3 rounded flex flex-col" style={{ height: "200px" }}>
          <h3 className="text-sm mb-2">Temperature</h3>
          <div className="flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <XAxis dataKey="time" hide />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="uvled" name="UV LED °C" stroke="#f97316" dot={false} />
                <Line type="monotone" dataKey="tank" name="Tank °C" stroke="#3b82f6" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 p-3 rounded text-center">
      <p className="text-sm text-gray-400">{title}</p>
      <p className="text-lg font-semibold text-green-400">{children}</p>
    </div>
  )
}
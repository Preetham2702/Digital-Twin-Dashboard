import React, { useEffect, useState } from "react"
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer
} from "recharts"

export default function Resin({ onConnectionChange }: { onConnectionChange?: (v: boolean) => void }) {

  const [data, setData] = useState<{ time: number; layer: number; cycle: number }[]>([])
  const [status, setStatus] = useState("Disconnected")
  const [progress, setProgress] = useState(0)
  const [layer, setLayer] = useState(0)
  const [totalLayers, setTotalLayers] = useState(0)
  const [zHeight, setZHeight] = useState(0)
  const [layerTime, setLayerTime] = useState(0)

  const [connected, setConnected] = useState(false)
  const [exposureTime, setExposureTime] = useState(0)
  const [bottomExposure, setBottomExposure] = useState(0)
  const [lightState, setLightState] = useState("OFF")

  useEffect(() => {
    let isMounted = true
    const socket = new WebSocket("ws://localhost:8000/ws/resin")

    socket.onopen = () => {
      // ✅ WebSocket connected
      if (!isMounted) return
      setConnected(true)
      if (typeof onConnectionChange === "function") onConnectionChange(true)
    }

    socket.onmessage = (event) => {
      if (!isMounted) return
      try {
        const msg = JSON.parse(event.data)

        // ❗ DO NOT USE printer_connected for UI connection
        // const isConnected = msg.printer_connected ?? false

        setStatus(msg.status ?? "Idle")
        setLayer(msg.layer ?? 0)
        setTotalLayers(msg.total_layers ?? 0)
        setProgress(msg.progress ?? 0)
        setZHeight(msg.z_height ?? 0)
        setLayerTime(msg.layer_time ?? 0)

        setExposureTime(msg.exposure_time ?? 0)
        setBottomExposure(msg.bottom_exposure ?? 0)
        setLightState(msg.light_state ?? "OFF")

        setData(prev => [
          ...prev.slice(-40),
          { time: prev.length, layer: msg.layer ?? 0, cycle: msg.layer_time ?? 0 }
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

  const startPrint = async () => { await fetch("http://localhost:8000/start", { method: "POST" }) }
  const pausePrint = async () => { await fetch("http://localhost:8000/pause", { method: "POST" }) }
  const stopPrint  = async () => { await fetch("http://localhost:8000/stop",  { method: "POST" }) }

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append("file", file)
    await fetch("http://localhost:8000/upload", { method: "POST", body: formData })
  }

  return (
    <div className="h-screen bg-slate-900 text-gray-200 flex overflow-hidden">

      {/* ===== LEFT PANEL ===== */}
      <div className="w-[30%] min-w-[340px] p-5 flex flex-col gap-4 border-r border-slate-700 overflow-hidden">

        <h2 className="text-lg font-semibold">Resin Machine</h2>

        <div>
          <p className="text-sm text-gray-400">Upload CTB File</p>
          <input type="file" onChange={uploadFile} className="w-full mt-2 bg-slate-800 p-2 rounded" />
        </div>

        <div className="flex gap-3">
          <button onClick={startPrint} className="flex-1 bg-green-600 hover:bg-green-700 rounded p-2">▶</button>
          <button onClick={pausePrint} className="flex-1 bg-yellow-500 hover:bg-yellow-600 rounded p-2 text-black">⏸</button>
          <button onClick={stopPrint}  className="flex-1 bg-red-600 hover:bg-red-700 rounded p-2">■</button>
        </div>

        <div className="flex-1 bg-black border border-slate-600 rounded overflow-hidden">
          
          {/* CAMERA STREAM */}
          <img
            src="http://localhost:8000/video_feed"
            alt="stream"
            className="w-full h-full object-cover"
            onError={(e) => {
              console.log("Camera stream failed")

              // fallback UI
              const target = e.currentTarget
              target.style.display = "none"

              const parent = target.parentElement
              if (parent) {
                parent.innerHTML = `
                  <div style="
                    width:100%;
                    height:100%;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    color:#64748b;
                    font-size:14px;
                  ">
                    Camera Not Available
                  </div>
                `
              }
            }}
          />

        </div>

      </div>

      {/* ===== RIGHT PANEL ===== */}
      <div className="flex-1 p-4 flex flex-col gap-5 overflow-hidden">

        <div className="grid grid-cols-4 gap-2">
          <Card title="Layer">{layer} / {totalLayers}</Card>
          <Card title="Z Height">{zHeight} mm</Card>
          <Card title="Layer Time">{layerTime} s</Card>
          <Card title="Status">{status} ({progress}%)</Card>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Card title="Exposure Time">{connected ? `${exposureTime} s` : "--"}</Card>
          <Card title="Bottom Exposure">{connected ? `${bottomExposure} s` : "--"}</Card>
          <Card title="Light">{connected ? lightState : "--"}</Card>
        </div>

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

        <div className="bg-slate-800 p-3 rounded flex flex-col" style={{ height: "200px" }}>
          <h3 className="text-sm mb-2">Cycle Time</h3>
          <div className="flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <XAxis dataKey="time" hide />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="cycle" stroke="#facc15" dot={false} />
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
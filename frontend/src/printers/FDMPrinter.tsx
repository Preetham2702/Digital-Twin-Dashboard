import { useEffect, useState } from "react"
import SemiGauge from "../components/SemiGauge"

export default function FDM() {

  const [connected, setConnected] = useState(false)
  const [showPopup, setShowPopup] = useState(false)

  const [status, setStatus] = useState("Idle")
  const [progress, setProgress] = useState(0)

  const [nozzleTemp, setNozzleTemp] = useState(0)
  const [nozzleTarget, setNozzleTarget] = useState(0)
  const [bedTemp, setBedTemp] = useState(0)
  const [bedTarget, setBedTarget] = useState(0)

  const [x, setX] = useState(0)
  const [y, setY] = useState(0)
  const [z, setZ] = useState(0)

  const [feedSpeed, setFeedSpeed] = useState(0)
  const [liveVelocity, setLiveVelocity] = useState(0)

  // =============================
  // WEBSOCKET
  // =============================
  useEffect(() => {
    const socket = new WebSocket("ws://localhost:8000/ws/printer")

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data)
      const isConnected = data.moonraker_connected ?? false

      setConnected(isConnected)
      setStatus(data.ui_state ?? "Idle")

      if (!isConnected) setShowPopup(true)

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
      setFeedSpeed(s.gcode_move?.speed ?? 0)
      setLiveVelocity(s.motion_report?.live_velocity ?? 0)
    }

    socket.onclose = () => {
      setConnected(false)
      setShowPopup(true)
    }

    return () => socket.close()
  }, [])

  // =============================
  // ACTIONS
  // =============================
  const handleUpload = async (e: any) => {
    if (!connected) {
      setShowPopup(true)
      return
    }

    const file = e.target.files[0]
    if (!file) return

    const formData = new FormData()
    formData.append("file", file)

    await fetch("http://localhost:8000/upload", {
      method: "POST",
      body: formData,
    })
  }

  const handleStart = async () => {
    if (!connected) {
      setShowPopup(true)
      return
    }

    await fetch("http://localhost:8000/start/yourfile.gcode", {
      method: "POST",
    })
  }

  const handleStop = async () => {
    if (!connected) {
      setShowPopup(true)
      return
    }

    await fetch("http://localhost:8000/stop", {
      method: "POST",
    })
  }

  return (
    <div className="flex flex-1 overflow-hidden relative">

      {/* POPUP */}
      {showPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-red-600 rounded-lg p-8 w-96 text-center shadow-2xl">
            <div className="text-red-500 text-5xl mb-4">⚠</div>
            <h2 className="text-xl font-semibold text-white mb-2">
              Machine Not Connected
            </h2>
            <p className="text-slate-300 text-sm mb-6">
              Make sure you are connected to the same WiFi network as the printer.
            </p>
            <button
              onClick={() => setShowPopup(false)}
              className="bg-red-600 hover:bg-red-700 px-6 py-2 rounded text-white transition"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* LEFT PANEL */}
      <div className="w-1/3 bg-slate-800 border-r border-slate-700 p-6 flex flex-col gap-6">

        <div>
          <p>Status: <span className="text-green-400">{status}</span></p>
          <p>Progress: {progress.toFixed(1)}%</p>
        </div>

        <div>
          <label className="text-sm text-slate-400">G-Code File</label>
          <input
            type="file"
            onClick={(e) => {
              if (!connected) {
                e.preventDefault()
                setShowPopup(true)
              }
            }}
            onChange={handleUpload}
            className="w-full text-sm bg-slate-700 p-2 rounded border border-slate-600 cursor-pointer"
          />
        </div>

        <div className="flex gap-4">
          <button onClick={handleStart} className="flex-1 bg-green-600 hover:bg-green-700 rounded p-2">
            Start
          </button>
          <button onClick={handleStop} className="flex-1 bg-red-600 hover:bg-red-700 rounded p-2">
            Stop
          </button>
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
      <div className="flex-1 p-6 space-y-8">

        <div className="flex gap-6">
          {[{label:"X",value:x},{label:"Y",value:y},{label:"Z",value:z}].map(axis => (
            <div key={axis.label} className="bg-slate-800 px-6 py-4 rounded border border-slate-700">
              <p className="text-sm text-slate-400">{axis.label} Position</p>
              <p className="text-2xl text-green-400">{axis.value.toFixed(2)} mm</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-8">
          <div className="bg-slate-800 p-6 rounded border border-slate-700">
            <h3>Nozzle</h3>
            <SemiGauge value={nozzleTemp} max={300} color="#f97316" />
            <p className="mt-2">Temp: {nozzleTemp.toFixed(1)}°C</p>
            <p className="text-slate-400">Target: {nozzleTarget}°C</p>
          </div>

          <div className="bg-slate-800 p-6 rounded border border-slate-700">
            <h3>Bed</h3>
            <SemiGauge value={bedTemp} max={120} color="#3b82f6" />
            <p className="mt-2">Temp: {bedTemp.toFixed(1)}°C</p>
            <p className="text-slate-400">Target: {bedTarget}°C</p>
          </div>
        </div>

        <div className="flex gap-8">
          <div className="bg-slate-800 p-6 rounded border border-slate-700">
            Feed Speed
            <p className="text-2xl text-purple-400">{feedSpeed.toFixed(2)} mm/s</p>
          </div>
          <div className="bg-slate-800 p-6 rounded border border-slate-700">
            Live Velocity
            <p className="text-2xl text-green-400">{liveVelocity.toFixed(2)} mm/s</p>
          </div>
        </div>

      </div>
    </div>
  )
}
import React, { useEffect, useState } from "react"
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid
} from "recharts"
import type { MachineSummary } from "../types/machine"
import { API_URL, WS_URL } from "../config"
import ConfirmDialog from "../components/ConfirmDialog"

type ResinFile = { path: string; name: string; is_folder: boolean; size: number }
type FileInfo = {
  layer_count: number; layer_height_mm: number; height_mm: number; resolution: string
  exposure_s: number; bottom_exposure_s: number; bottom_layers: number
  print_time_s: number; volume_ml: number; material_g: number; machine: string; slicer: string
  display_w_mm?: number; display_h_mm?: number
}

export default function Resin({
  onConnectionChange,
  onSummary,
}: {
  onConnectionChange?: (v: boolean) => void
  onSummary?: (s: MachineSummary) => void
}) {

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

  // Camera: one MJPEG push stream from the backend (frames arrive as soon as
  // they're decoded — no polling delay). The <img> stays mounted; on error we
  // hide it and re-attach after 3s with a fresh URL.
  const [streamKey, setStreamKey] = useState(() => Date.now())
  useEffect(() => {
    setPreviewSrc(`${API_URL}/preview/stream?t=${streamKey}`)
  }, [streamKey])
  const onCamLoad = () => {
    if (!cameraOk) console.log("[RESIN VIDEO] ✅ Stream connected")
    setCameraOk(true)
  }
  const onCamError = () => {
    if (cameraOk) console.log("[RESIN VIDEO] ❌ Stream lost — retrying in 3s")
    setCameraOk(false)
    setTimeout(() => setStreamKey(Date.now()), 3000)
  }
  const [uvledTemp, setUvledTemp] = useState(0)
  const [tankTemp, setTankTemp] = useState(0)
  const [tankTarget, setTankTarget] = useState(0)
  const [heatOn, setHeatOn] = useState(false)
  const [timelapse, setTimelapse] = useState(false)
  const [filmCount, setFilmCount] = useState(0)
  const [filmMax, setFilmMax] = useState(60000)
  const [errorNum, setErrorNum] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [vatMl, setVatMl] = useState<number | null>(null)
  const [vatLow, setVatLow] = useState(50)

  useEffect(() => {
    let isMounted = true
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (!isMounted) return

      const socket = new WebSocket(`${WS_URL}/ws/resin`)

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

          const currentStatus = msg.status ?? "Idle"
          const currentProgress = msg.progress ?? 0
          const currentUvledTemp = msg.uvled_temp_c ?? 0
          const currentTankTemp = msg.tank_temp_c ?? 0

          // Backend `progress` is already 0–100 (ticks can overshoot to ~100.01 at
          // the end), so clamp — don't scale. A finished/idle job is not "running".
          const pct = Math.min(100, Math.max(0, currentProgress))
          const st = String(currentStatus).toUpperCase()
          const active = pct > 0 && pct < 100 && !["IDLE", "FINISHED", "STOPPED", "STOPPING"].includes(st)
          onSummary?.({
            status: printerUp ? (active ? "running" : "idle") : "offline",
            progress: active ? pct : null,
            temps: [
              { label: "UV LED", value: currentUvledTemp },
              { label: "Tank", value: currentTankTemp },
            ],
            detail: currentStatus,
          })

          setStatus(currentStatus)
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
          setErrorMsg(msg.error_message ?? null)
          setVatMl(msg.vat_ml ?? null)
          setVatLow(msg.vat_low_ml ?? 50)


        } catch (err) {
          console.error("WebSocket parse error:", err)
        }
      }

      socket.onclose = () => {
        if (!isMounted) return
        setStatus("Disconnected")
        setConnected(false)
        if (typeof onConnectionChange === "function") onConnectionChange(false)
        // Auto-reconnect when the socket closes
        reconnectTimeout = setTimeout(connect, 3000)
      }
    }

    connect()

    return () => {
      isMounted = false
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
    }
  }, [])

  // ── Files on the printer + controls (all /resin/* — real SDCP commands) ──
  const [files, setFiles] = useState<ResinFile[]>([])
  const [selected, setSelected] = useState("")
  const [filesLoading, setFilesLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirm, setConfirm] = useState<null | "print" | "stop" | { del: string }>(null)
  const [fileOpen, setFileOpen] = useState(false)          // select-file dropdown
  const [menuFor, setMenuFor] = useState<string | null>(null) // row whose ⋮ menu is open
  const fileBoxRef = React.useRef<HTMLDivElement>(null)

  // close dropdown / ⋮ menu on outside click
  useEffect(() => {
    if (!fileOpen) return
    const onDown = (e: MouseEvent) => {
      if (fileBoxRef.current && !fileBoxRef.current.contains(e.target as Node)) {
        setFileOpen(false); setMenuFor(null)
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [fileOpen])

  const flash = (ok: boolean, text: string) => {
    setNotice({ ok, text })
    setTimeout(() => setNotice(null), 4000)          // auto-dismiss
  }

  const loadFiles = async () => {
    setFilesLoading(true)
    try {
      const res = await fetch(`${API_URL}/resin/files`)
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText)
      const j = await res.json()
      const list: ResinFile[] = (j.files ?? []).filter((f: ResinFile) => !f.is_folder)
      setFiles(list)
      console.log(`[RESIN FILES] ${list.length} file(s)`)
    } catch (e) {
      console.log("[RESIN FILES] ❌", e)
      flash(false, `File list failed: ${e}`)
    } finally {
      setFilesLoading(false)
    }
  }

  // load once the printer connection comes up
  useEffect(() => { if (connected) loadFiles() }, [connected])

  const ctrl = async (endpoint: string, label: string) => {
    try {
      const res = await fetch(`${API_URL}/resin/${endpoint}`, { method: "POST" })
      const j = await res.json()
      const ok = res.ok && j.success
      console.log(`[RESIN CTRL] ${label}: ${j.message ?? j.detail}`)
      flash(ok, `${label}: ${j.message ?? j.detail}`)
    } catch (e) {
      flash(false, `${label} failed: ${e}`)
    }
  }

  const startPrint = () =>
    ctrl(`print?filename=${encodeURIComponent(selected)}&start_layer=${Math.max(0, startFrom - 1)}`,
      `Start ${selected.split("/").pop()}${startFrom > 1 ? ` from layer ${startFrom}` : ""}`)

  const deleteFile = async (path: string) => {
    const res = await fetch(`${API_URL}/resin/files?filename=${encodeURIComponent(path)}`, { method: "DELETE" })
    const j = await res.json().catch(() => ({}))
    flash(res.ok && j.success, res.ok && j.success ? "File deleted" : "Delete failed")
    if (selected === path) setSelected("")
    loadFiles()
  }

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (file) doUpload(file)
  }
  const doUpload = async (file: File) => {
    if (!/\.(goo|ctb)$/i.test(file.name)) { flash(false, "Only .goo or .ctb files"); return }
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch(`${API_URL}/resin/upload`, { method: "POST", body: formData })
      const j = await res.json()
      flash(!!j.success, j.success ? `Uploaded ${file.name}` : `Upload failed: ${j.message}`)
      if (j.success) loadFiles()
    } catch (err) {
      flash(false, `Upload failed: ${err}`)
    } finally {
      setUploading(false)
    }
  }

  const fmtSize = (b: number) =>
    b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`

  const st = status.toUpperCase()
  const isPrinting = ["PRINTING", "EXPOSURE"].includes(st)
  const isPaused = st === "PAUSED"

  // ── File details / thumbnail for the active (printing) or selected file ──
  const activeFile = (isPrinting || isPaused) && filename ? filename : selected
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null)
  const [hasThumb, setHasThumb] = useState(false)
  const [infoLoading, setInfoLoading] = useState(false)
  useEffect(() => {
    if (!activeFile) { setFileInfo(null); setHasThumb(false); return }
    let alive = true
    setInfoLoading(true)
    fetch(`${API_URL}/resin/file-info?filename=${encodeURIComponent(activeFile)}`)
      .then(r => r.json())
      .then(j => { if (alive) { setFileInfo(j.info ?? null); setHasThumb(!!j.has_thumbnail) } })
      .catch(() => { if (alive) { setFileInfo(null); setHasThumb(false) } })
      .finally(() => alive && setInfoLoading(false))
    return () => { alive = false }
  }, [activeFile])

  // ── Timelapse on/off (SDCP Cmd 387) ──
  const [tlBusy, setTlBusy] = useState(false)
  const toggleTimelapse = async () => {
    const next = !timelapse
    setTlBusy(true)
    try {
      const res = await fetch(`${API_URL}/resin/timelapse?on=${next}`, { method: "POST" })
      const j = await res.json()
      if (res.ok && j.success) { setTimelapse(next); console.log(`[RESIN CTRL] 🎞 Timelapse ${next ? "ON" : "OFF"}`) }
      else flash(false, `Timelapse: ${j.message ?? j.detail}`)
    } catch (e) {
      flash(false, `Timelapse failed: ${e}`)
    } finally {
      setTlBusy(false)
    }
  }

  // ── (1) Finish clock time ──
  const doneAt = (isPrinting || isPaused) && remainingMin > 0
    ? new Date(Date.now() + remainingMin * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null

  // ── (3) Print alerts: toast + browser notification on finish / pause / stop / error ──
  const [toasts, setToasts] = useState<{ id: number; tone: "ok" | "warn" | "err"; text: string }[]>([])
  const pushAlert = (tone: "ok" | "warn" | "err", text: string) => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, tone, text }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 8000)       // auto-dismiss
    console.log(`[RESIN ALERT] ${text}`)
    try {
      if ("Notification" in window && Notification.permission === "granted" && document.hidden)
        new Notification("Resin printer", { body: text })
    } catch { /* notifications unavailable */ }
  }
  useEffect(() => {
    try {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission()
    } catch { /* ignore */ }
  }, [])
  const alertRef = React.useRef({ st: "", started: 0, file: "", layer: 0, total: 0, progress: 0, err: 0 })
  useEffect(() => {
    const a = alertRef.current
    const prev = a.st
    const name = (filename || a.file).split("/").pop() || "print"
    const active = (x: string) => ["PRINTING", "EXPOSURE"].includes(x)
    if (prev && prev !== st) {
      if (active(st) && !active(prev) && prev !== "PAUSED") a.started = Date.now()
      if (st === "PAUSED" && active(prev)) pushAlert("warn", `⏸ Resin print paused at layer ${layer}/${totalLayers}: ${name}`)
      if (active(prev) || prev === "PAUSED") {
        const dur = a.started ? ` (${fmtDuration((Date.now() - a.started) / 1000)})` : ""
        if (st === "FINISHED" || (st === "IDLE" && a.progress >= 99))
          pushAlert("ok", `✅ Resin print finished: ${name}${dur}`)
        else if (["STOPPED", "STOPPING", "IDLE"].includes(st))
          pushAlert("warn", `■ Resin print stopped at layer ${a.layer}/${a.total}: ${name}`)
      }
    }
    if (errorNum !== 0 && a.err === 0 && connected) pushAlert("err", `⚠ Resin printer error: ${errorMsg ?? errorNum}`)
    Object.assign(a, { st, file: filename || a.file, layer, total: totalLayers, progress, err: errorNum })
  }, [st, errorNum, layer])

  // ── (5) Live layer view ──
  const [layerState, setLayerState] = useState<{ state: string; done?: number; total?: number }>({ state: "idle" })
  const [scrubLayer, setScrubLayer] = useState(1)
  useEffect(() => { setScrubLayer(1) }, [activeFile])
  useEffect(() => {
    if (!activeFile || !activeFile.toLowerCase().endsWith(".goo")) { setLayerState({ state: "unsupported" }); return }
    let alive = true
    let t: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const j = await (await fetch(`${API_URL}/resin/layer-status?filename=${encodeURIComponent(activeFile)}`)).json()
        if (!alive) return
        setLayerState(j)
        if (j.state === "downloading") t = setTimeout(poll, 1500)
      } catch { if (alive) t = setTimeout(poll, 5000) }
    }
    poll()
    return () => { alive = false; if (t) clearTimeout(t) }
  }, [activeFile])
  const printingThisFile = (isPrinting || isPaused) && !!filename && activeFile === filename
  const shownLayer = printingThisFile ? Math.max(1, layer) : scrubLayer
  // file analysis (areas, islands, peel jumps, planned layer times) — shared by preview + chart
  const [profile, setProfile] = useState<AreaProfile>({ state: "idle" })
  useEffect(() => {
    if (layerState.state !== "ready" || !activeFile) { setProfile({ state: "idle" }); return }
    let alive = true
    let t: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const j: AreaProfile = await (await fetch(`${API_URL}/resin/area-profile?filename=${encodeURIComponent(activeFile)}`)).json()
        if (!alive) return
        setProfile(j)
        if (j.state !== "ready" && j.state !== "failed") t = setTimeout(poll, 1000)
      } catch { if (alive) t = setTimeout(poll, 3000) }
    }
    poll()
    return () => { alive = false; if (t) clearTimeout(t) }
  }, [activeFile, layerState.state])

  // Logs window (reports · timelapse · maintenance) + maintenance reminder badge
  const [logsOpen, setLogsOpen] = useState(false)
  const [maintDue, setMaintDue] = useState(0)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try { const j = await (await fetch(`${API_URL}/resin/maintenance`)).json(); if (alive) setMaintDue((j.reminders ?? []).length) } catch { /* ignore */ }
    }
    load()
    const t = setInterval(load, 60000)
    return () => { alive = false; clearInterval(t) }
  }, [logsOpen])

  // start-from-layer (1-based in the UI, 0-based for the printer)
  const [startFrom, setStartFrom] = useState(1)
  useEffect(() => { setStartFrom(1) }, [selected])

  const layerUrl = layerState.state === "ready" && activeFile
    ? `${API_URL}/resin/layer?filename=${encodeURIComponent(activeFile)}&layer=${shownLayer}&v=3`
    : null

  // ── (10) Skip preheat (SDCP Cmd 133) ──
  const waitingForHeat = (isPrinting || isPaused) && heatOn && tankTarget > 0 && tankTemp < tankTarget - 0.5 && layer <= 0

  // ── Vat resin (estimate: refills logged by user, prints deducted by backend) ──
  const [vatOpen, setVatOpen] = useState(false)
  const vatBarRef = React.useRef<HTMLDivElement>(null)
  const vatPopRef = React.useRef<HTMLDivElement>(null)
  const [vatPos, setVatPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  // Position the popup to the RIGHT of the vat bar (fixed, so the left panel's
  // overflow can't clip it). Falls back to below the bar on narrow screens.
  const openVat = () => {
    if (vatOpen) { setVatOpen(false); return }
    const r = vatBarRef.current?.getBoundingClientRect()
    if (r) {
      const W = 300, H = 230
      const right = r.right + 8
      const fitsRight = right + W <= window.innerWidth - 8
      setVatPos(fitsRight
        ? { top: Math.min(r.top, window.innerHeight - H - 8), left: right }
        : { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) })
    }
    setVatOpen(true)
  }
  useEffect(() => {
    if (!vatOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!vatPopRef.current?.contains(t) && !vatBarRef.current?.contains(t)) setVatOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setVatOpen(false) }
    const close = () => setVatOpen(false)
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", close)
    }
  }, [vatOpen])
  const [vatInput, setVatInput] = useState("")
  const [lowInput, setLowInput] = useState("")
  const vatUpdate = async (q: string) => {
    try {
      const res = await fetch(`${API_URL}/resin/vat?${q}`, { method: "POST" })
      const j = await res.json()
      if (!res.ok) throw new Error(j.detail ?? res.statusText)
      setVatMl(j.ml); setVatLow(j.low_ml)
      setVatOpen(false); setVatInput(""); setLowInput("")
      console.log(`[RESIN VAT] Vat ~${j.ml} ml`)
    } catch (e) {
      flash(false, `Vat update failed: ${e}`)
    }
  }
  const needMl = fileInfo?.volume_ml ?? null
  const vatTone = vatMl == null ? "unknown"
    : (needMl != null && vatMl < needMl) || vatMl <= vatLow * 0.5 ? "bad"
    : vatMl <= vatLow ? "low" : "ok"

  const formatRemaining = (min: number) => {
    if (min <= 0) return "0m"
    const h = Math.floor(min / 60)
    const m = Math.round(min % 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  return (
    <div className="flex flex-col lg:flex-row min-h-full lg:h-full lg:overflow-hidden">

      {/* ===== LEFT PANEL ===== */}
      <div className="w-full lg:w-[30%] lg:min-w-[300px] p-3 sm:p-5 flex flex-col gap-4 border-b lg:border-b-0 lg:border-r border-slate-700 lg:overflow-hidden">

        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Resin Machine</h2>
          <button onClick={() => setLogsOpen(true)}
            className="relative text-sm text-gray-400 hover:text-slate-100 bg-slate-800 hover:bg-slate-700 rounded px-3 py-1">
            Logs
            {maintDue > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-yellow-500 text-black text-[11px] font-bold flex items-center justify-center"
                title="Maintenance reminders">{maintDue}</span>
            )}
          </button>
        </div>
        {logsOpen && <ResinLogs onClose={() => setLogsOpen(false)} />}

        {/* Upload */}
        <div>
          <p className="text-sm text-gray-400">Upload Print File (.goo / .ctb)</p>
          <input type="file" accept=".goo,.ctb" onChange={uploadFile} disabled={uploading || !connected}
            className="w-full mt-2 bg-slate-800 p-2 rounded disabled:opacity-50" />
          {uploading && <p className="text-xs text-blue-400 mt-1">Uploading to printer…</p>}
        </div>

        {/* Select file (dropdown, scrollable) */}
        <div className="relative w-full" ref={fileBoxRef}>
          <button
            disabled={!connected}
            onClick={() => {
              const next = !fileOpen
              setFileOpen(next); setMenuFor(null)
              if (next) loadFiles()                       // fresh list every open
            }}
            className="w-full flex items-center justify-between bg-slate-800 p-2 rounded text-left disabled:opacity-50"
          >
            <span className="truncate">{selected ? selected.split("/").pop() : "Select file..."}</span>
            <span className="text-xs text-slate-400 shrink-0 ml-2">{filesLoading ? "Loading…" : fileOpen ? "▲" : "▼"}</span>
          </button>

          {fileOpen && (
            <div className="absolute z-40 mt-1 w-full bg-slate-800 border border-slate-700 rounded max-h-[200px] overflow-y-auto">
              {files.length === 0 && (
                <p className="px-2 py-2 text-xs text-slate-500">{filesLoading ? "Loading…" : "No files on printer"}</p>
              )}
              {files.map(f => (
                <div key={f.path}
                  onClick={() => { setSelected(f.path); setFileOpen(false); setMenuFor(null) }}
                  className={`relative flex items-center justify-between px-2 py-1.5 text-sm cursor-pointer ${
                    selected === f.path ? "bg-blue-600/30" : "hover:bg-slate-700"}`}>
                  <span className="truncate" title={f.name}>{f.name}</span>
                  <span className="flex items-center gap-1 shrink-0 text-xs text-slate-400">
                    {f.size ? fmtSize(f.size) : ""}
                    <button title="More"
                      onClick={ev => { ev.stopPropagation(); setMenuFor(menuFor === f.path ? null : f.path) }}
                      className="px-1.5 text-base leading-none hover:text-slate-100">⋮</button>
                  </span>

                  {menuFor === f.path && (
                    <div onClick={ev => ev.stopPropagation()}
                      className="absolute right-2 top-full z-50 mt-0.5 bg-slate-900 border border-slate-600 rounded shadow-lg">
                      <button
                        onClick={() => { setMenuFor(null); setFileOpen(false); setConfirm({ del: f.path }) }}
                        className="block w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-slate-800">
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Vat resin */}
        <div className="relative">
          <div ref={vatBarRef} className={`flex items-center justify-between rounded border px-2 py-1.5 text-sm ${
            vatTone === "bad" ? "border-red-500/60 bg-red-500/10"
            : vatTone === "low" ? "border-yellow-500/60 bg-yellow-500/10"
            : "border-slate-700 bg-slate-800"}`}>
            <span className="min-w-0 truncate">
              <span className="text-gray-400">Vat resin </span>
              <span className={`font-semibold ${vatTone === "bad" ? "text-red-300" : vatTone === "low" ? "text-yellow-300" : "text-green-400"}`}>
                {vatMl == null ? "not set" : `~${Math.round(vatMl)} ml`}
              </span>
              {needMl != null && !(isPrinting || isPaused) && (
                <span className="text-xs text-slate-400"> · file needs {needMl} ml</span>
              )}
            </span>
            <button onClick={openVat}
              className="text-xs text-blue-400 hover:text-blue-300 shrink-0 ml-2">
              {vatMl == null ? "Set level" : "Refill"}
            </button>
          </div>

          {vatOpen && (
            <div ref={vatPopRef} style={{ position: "fixed", top: vatPos.top, left: vatPos.left, width: 300 }}
              className="z-[70] rounded border border-slate-600 bg-slate-900 p-3 shadow-xl flex flex-col gap-2">
              <label className="text-xs text-gray-400">Resin amount (ml)</label>
              <input type="number" min={0} value={vatInput} onChange={e => setVatInput(e.target.value)}
                placeholder="e.g. 200" className="bg-slate-800 rounded p-1.5 text-sm" autoFocus />
              <div className="flex gap-2">
                <button disabled={!vatInput} onClick={() => vatUpdate(`add_ml=${Number(vatInput)}`)}
                  className="flex-1 rounded border border-slate-600 bg-slate-700 hover:bg-slate-600 p-1.5 text-sm disabled:opacity-40">Add</button>
                <button disabled={vatInput === ""} onClick={() => vatUpdate(`set_ml=${Number(vatInput)}`)}
                  className="flex-1 rounded border border-slate-600 hover:bg-slate-800 p-1.5 text-sm disabled:opacity-40">Set level</button>
              </div>
              <div className="flex items-center gap-2 pt-1 border-t border-slate-700">
                <label className="text-xs text-gray-400 shrink-0">Warn below</label>
                <input type="number" min={0} value={lowInput} onChange={e => setLowInput(e.target.value)}
                  placeholder={`${vatLow}`} className="bg-slate-800 rounded p-1 text-sm w-20" />
                <span className="text-xs text-gray-400">ml</span>
                <button disabled={!lowInput} onClick={() => vatUpdate(`low_ml=${Number(lowInput)}`)}
                  className="ml-auto text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">Save</button>
              </div>
              <button onClick={() => setVatOpen(false)} className="text-xs text-slate-400 hover:text-slate-200 self-end">Close</button>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex gap-3">
          <button title="Start selected file" disabled={!connected || !selected || isPrinting || isPaused}
            onClick={() => setConfirm("print")}
            className="flex-1 bg-green-600 hover:bg-green-700 rounded p-2 disabled:opacity-40">▶</button>
          {isPaused ? (
            <button title="Resume" onClick={() => ctrl("resume", "Resume")}
              className="flex-1 bg-blue-600 hover:bg-blue-700 rounded p-2">⏵</button>
          ) : (
            <button title="Pause" disabled={!isPrinting} onClick={() => ctrl("pause", "Pause")}
              className="flex-1 bg-yellow-500 hover:bg-yellow-600 rounded p-2 text-black disabled:opacity-40">⏸</button>
          )}
          <button title="Stop" disabled={!isPrinting && !isPaused} onClick={() => setConfirm("stop")}
            className="flex-1 bg-red-600 hover:bg-red-700 rounded p-2 disabled:opacity-40">■</button>
        </div>
        {selected && !(isPrinting || isPaused) && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <label htmlFor="startFrom">Start from layer</label>
            <input id="startFrom" type="number" min={1} max={fileInfo?.layer_count ?? undefined} value={startFrom}
              onChange={e => {
                const n = Math.max(1, Math.min(fileInfo?.layer_count ?? 1e6, Number(e.target.value) || 1))
                setStartFrom(n); setScrubLayer(n)                // preview the layer it will start on
              }}
              className="w-20 bg-slate-800 rounded px-2 py-1 text-slate-100" />
            {fileInfo && <span>of {fileInfo.layer_count}</span>}
            {startFrom > 1 && (
              <button onClick={() => { setStartFrom(1); setScrubLayer(1) }} className="ml-auto text-blue-400 hover:text-blue-300">Reset</button>
            )}
          </div>
        )}
        {waitingForHeat && (
          <button onClick={() => ctrl("skip-preheat", "Skip preheat")}
            className="text-xs text-orange-300 hover:text-orange-200 self-start">
            🔥 Waiting for tank {tankTemp}/{tankTarget} °C — skip preheat
          </button>
        )}
        {notice && (
          <p className={`text-xs ${notice.ok ? "text-green-400" : "text-red-400"}`}>{notice.text}</p>
        )}

        <ConfirmDialog
          open={confirm !== null}
          title={confirm === "print" ? "Start print?" : confirm === "stop" ? "Stop print?" : "Delete file?"}
          message={
            confirm === "print"
              ? `Start printing ${selected.split("/").pop()} on the Saturn 4 Ultra?` + (
                  startFrom > 1
                    ? `\n\nStarting from layer ${startFrom}${fileInfo ? ` (Z ${(startFrom * fileInfo.layer_height_mm).toFixed(2)} mm)` : ""}. ` +
                      "The part must still be on the build plate, undisturbed."
                    : "") + (
                  needMl == null ? ""
                  : vatMl == null ? `\n\nNeeds ${needMl} ml of resin (vat level not set).`
                  : vatMl < needMl ? `\n\n⚠ Needs ${needMl} ml but the vat has only ~${Math.round(vatMl)} ml — top up before printing.`
                  : `\n\nNeeds ${needMl} ml · vat has ~${Math.round(vatMl)} ml ✅`)
            : confirm === "stop" ? "This cancels the current resin print. It cannot be resumed."
            : confirm && typeof confirm === "object" ? `Delete ${confirm.del.split("/").pop()} from the printer?` : ""
          }
          confirmLabel={confirm === "print" ? "Start" : confirm === "stop" ? "Stop" : "Delete"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm
            setConfirm(null)
            if (c === "print") startPrint()
            else if (c === "stop") ctrl("stop", "Stop")
            else if (c && typeof c === "object") deleteFile(c.del)
          }}
        />

        <div
          className="aspect-video lg:aspect-auto lg:flex-1 min-h-[200px] bg-black border border-slate-600 rounded overflow-hidden cursor-pointer relative"
          onClick={() => cameraOk && setFullscreen(true)}
        >
          <img
            src={previewSrc}
            className={`w-full h-full object-cover ${cameraOk ? "" : "hidden"}`}
            onLoad={onCamLoad}
            onError={onCamError}
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

      {/* Alerts (auto-dismiss) */}
      <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
        {toasts.map(t => (
          <div key={t.id}
            className={`pointer-events-auto rounded border px-3 py-2 text-sm shadow-lg bg-slate-900 ${
              t.tone === "ok" ? "border-green-500/60 text-green-200"
              : t.tone === "warn" ? "border-yellow-500/60 text-yellow-200" : "border-red-500/60 text-red-200"}`}
            onClick={() => setToasts(x => x.filter(y => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>

      {/* ===== RIGHT PANEL ===== */}
      <div className="flex-1 min-w-0 p-3 sm:p-4 flex flex-col gap-3 lg:overflow-hidden">

        {/* Error banner — clears itself when the printer's error number returns to 0 */}
        {connected && errorNum !== 0 && (
          <div className="flex items-start gap-3 rounded border border-red-500/60 bg-red-500/10 px-3 py-2">
            <span className="text-red-400 text-lg leading-none">⚠</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-red-300">Printer error {errorNum}</p>
              <p className="text-xs text-red-200/80">{errorMsg ?? "Unknown error — check the printer screen"}</p>
            </div>
          </div>
        )}

        {/* Row 1 — Print info */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card title="Layer">{layer} / {totalLayers}</Card>
          <Card title="Z Height">{zHeight} mm</Card>
          <Card title="Remaining">
            {connected ? formatRemaining(remainingMin) : "--"}
            {doneAt && <span className="block text-[11px] font-normal text-slate-400">Done {doneAt}</span>}
          </Card>
          <Card title="Status">{status} ({progress}%)</Card>
        </div>

        {/* Row 2 — Temperatures */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card title="UV LED Temp">{connected ? `${uvledTemp} °C` : "--"}</Card>
          <Card title="Tank Temp">{connected ? `${tankTemp} °C` : "--"}</Card>
          <Card title="Tank Target">{connected ? `${tankTarget} °C` : "--"}</Card>
          <Card title="Heater">{connected ? (heatOn ? "ON" : "OFF") : "--"}</Card>
        </div>

        {/* Row 3 — Machine info */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card title="Release Film">{connected ? `${filmCount}` : "--"}</Card>
          <Card title="Film Max">{connected ? `${filmMax}` : "--"}</Card>
          <button
            disabled={!connected || tlBusy}
            onClick={toggleTimelapse}
            title={timelapse ? "Turn timelapse off" : "Turn timelapse on"}
            className="bg-slate-800 hover:bg-slate-700 p-2 sm:p-3 rounded text-center min-w-0 disabled:opacity-60 disabled:hover:bg-slate-800"
          >
            <p className="text-xs sm:text-sm text-gray-400 truncate">Timelapse</p>
            <span className="inline-flex items-center gap-2 mt-1">
              <span className={`relative inline-block w-9 h-5 rounded-full transition-colors ${timelapse ? "bg-green-500" : "bg-slate-600"}`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${timelapse ? "translate-x-4" : ""}`} />
              </span>
              <span className={`text-base sm:text-lg font-semibold ${timelapse ? "text-green-400" : "text-slate-400"}`}>
                {connected ? (tlBusy ? "…" : timelapse ? "ON" : "OFF") : "--"}
              </span>
            </span>
          </button>
          <Card title="Errors">{connected ? `${errorNum}` : "--"}</Card>
        </div>

        {/* File details + thumbnail */}
        <FilePanel
          name={activeFile ? activeFile.split("/").pop()! : ""}
          printing={(isPrinting || isPaused) && !!filename}
          info={fileInfo}
          loading={infoLoading}
          progress={progress}
          thumbUrl={hasThumb && activeFile ? `${API_URL}/resin/thumbnail?filename=${encodeURIComponent(activeFile)}` : null}
        />

        {/* Layer preview + build height (replaces Layer vs Time chart) */}
        <div className="flex flex-col md:flex-row gap-2 h-auto md:h-[240px] lg:h-auto lg:flex-1 lg:min-h-[200px]">
          <LayerView
            url={layerUrl}
            state={activeFile ? layerState : { state: "none" }}
            layer={shownLayer}
            total={fileInfo?.layer_count ?? totalLayers}
            live={printingThisFile}
            onScrub={setScrubLayer}
            filename={activeFile}
            profile={profile}
            aspect={fileInfo?.display_w_mm && fileInfo?.display_h_mm ? fileInfo.display_w_mm / fileInfo.display_h_mm : 211.68 / 118.37}
          />
          <BuildHeight
            currentMm={printingThisFile && zHeight > 0 ? zHeight : (fileInfo ? shownLayer * fileInfo.layer_height_mm : 0)}
            modelMm={fileInfo?.height_mm ?? 0}
            machineMm={220}
          />
        </div>

        {/* Cured area per layer (replaces Temperature chart) */}
        <AreaProfileChart
          filename={activeFile}
          ready={layerState.state === "ready"}
          profile={profile}
          layer={shownLayer}
          live={printingThisFile}
          onScrub={setScrubLayer}
        />

      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 p-2 sm:p-3 rounded text-center min-w-0">
      <p className="text-xs sm:text-sm text-gray-400 truncate">{title}</p>
      <p className="text-base sm:text-lg font-semibold text-green-400 break-words">{children}</p>
    </div>
  )
}

// ───────────────────────── resin sub-components ─────────────────────────

function fmtDuration(s: number) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function FilePanel({ name, printing, info, loading, thumbUrl, progress }:
  { name: string; printing: boolean; info: FileInfo | null; loading: boolean; thumbUrl: string | null; progress: number }) {
  if (!name) {
    return (
      <div className="bg-slate-800 px-3 py-2 rounded text-sm text-slate-500 shrink-0">
        Select a file to see its print parameters
      </div>
    )
  }
  const rows: [string, string][] = info ? [
    ["Layers", `${info.layer_count}`],
    ["Layer height", `${info.layer_height_mm} mm`],
    ["Model height", `${info.height_mm} mm`],
    ["Est. time", info.print_time_s ? fmtDuration(info.print_time_s) : "--"],
    printing
      ? ["Resin used", `${(info.volume_ml * Math.min(100, progress) / 100).toFixed(1)} / ${info.volume_ml} ml`]
      : ["Resin", `${info.volume_ml} ml${info.material_g ? ` · ${info.material_g} g` : ""}`],
    ["Exposure", `${info.exposure_s} s`],
    ["Bottom exposure", `${info.bottom_exposure_s} s × ${info.bottom_layers}`],
    ["Resolution", info.resolution],
    ["Sliced for", info.machine || "--"],
  ] : []
  return (
    <div className="bg-slate-800 p-3 rounded flex gap-3 min-w-0 shrink-0">
      <div className="w-20 h-20 shrink-0 rounded bg-slate-900 border border-slate-700 overflow-hidden flex items-center justify-center">
        {thumbUrl
          ? <img src={thumbUrl} className="w-full h-full object-contain" />
          : <span className="text-[10px] text-slate-500 text-center px-1">{loading ? "Loading…" : "No preview"}</span>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-gray-400">{printing ? "Printing now" : "Selected file"}</p>
        <p className="text-sm font-semibold truncate" title={name}>{name}</p>
        {loading && !info && <p className="text-xs text-slate-500 mt-1">Reading print parameters…</p>}
        {!loading && !info && (
          <p className="text-xs text-slate-500 mt-1">
            {name.toLowerCase().endsWith(".goo") ? "Couldn't read parameters from the printer" : "Parameters are only available for .goo files"}
          </p>
        )}
        {info && (
          <dl className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 text-xs">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 min-w-0">
                <dt className="text-slate-400 shrink-0">{k}</dt>
                <dd className="text-slate-200 truncate text-right">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}

type LayerMeta = { layer: number; z_mm: number; exposure_s: number; wait_before_cure_s: number; pwm: number; phase: string; area_mm2: number }
type Island = { x: number; y: number; cells: number }
type AreaProfile = {
  state: string; done?: number; total?: number; areas?: number[]; max_layer?: number; max_area?: number
  islands?: { layer: number; count: number; pts: Island[] }[]; peel?: number[]; cum_s?: number[]
}

const PHASE_STYLE: Record<string, string> = {
  BOTTOM: "bg-orange-500/20 text-orange-300",
  TRANSITION: "bg-yellow-500/20 text-yellow-300",
  NORMAL: "bg-green-500/20 text-green-300",
}

function LayerView({ url, state, layer, total, live, onScrub, filename, profile, aspect }: {
  url: string | null; state: { state: string; done?: number; total?: number }
  layer: number; total: number; live: boolean; onScrub: (n: number) => void; filename: string
  profile: AreaProfile; aspect: number
}) {
  const islandsHere = profile.islands?.find(i => i.layer === layer)
  const peelHere = profile.peel?.includes(layer)

  // live: actual vs planned layer time
  const [times, setTimes] = useState<{ layers: [number, number][]; current: { layer: number; elapsed_s: number } | null } | null>(null)
  useEffect(() => {
    if (!live) { setTimes(null); return }
    let alive = true
    const load = async () => {
      try { const j = await (await fetch(`${API_URL}/resin/layer-times?last=60`)).json(); if (alive) setTimes(j) } catch { /* ignore */ }
    }
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [live])
  const cum = profile.cum_s
  const planOf = (l: number) => cum && l >= 2 && l <= cum.length ? cum[l - 1] - cum[l - 2] : null
  const lastDone = times?.layers?.length ? times.layers[times.layers.length - 1] : null
  const drift = (() => {
    if (!times?.layers?.length || !cum) return null
    let actual = 0, plan = 0
    for (const [l, sec] of times.layers) { const p = planOf(l); if (p != null) { actual += sec; plan += p } }
    return plan > 0 ? actual - plan : null
  })()
  const fmtSec = (v: number) => Math.abs(v) >= 60 ? `${Math.floor(Math.abs(v) / 60)}m ${Math.round(Math.abs(v) % 60)}s` : `${Math.abs(v).toFixed(1)}s`
  const [shown, setShown] = useState<string | null>(null)        // keep last good image while next loads
  useEffect(() => {
    if (!url) { setShown(null); return }
    const img = new Image()
    img.onload = () => setShown(url)
    img.src = url
  }, [url])

  // per-layer values from the file (debounced while scrubbing)
  const [meta, setMeta] = useState<LayerMeta | null>(null)
  useEffect(() => {
    if (state.state !== "ready" || !filename) { setMeta(null); return }
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API_URL}/resin/layer-meta?filename=${encodeURIComponent(filename)}&layer=${layer}`)
        if (r.status === 200 && alive) setMeta(await r.json())
      } catch { /* keep last */ }
    }, 120)
    return () => { alive = false; clearTimeout(t) }
  }, [filename, layer, state.state])


  const pct = state.total ? Math.round(((state.done ?? 0) / state.total) * 100) : null
  return (
    <div className="bg-slate-800 p-3 rounded flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-sm">{live ? "Live Layer" : "Layer Preview"}</h3>
        <span className="flex items-center gap-2 text-xs text-gray-400">
          Layer {layer} / {total || "--"}
          {islandsHere && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/20 text-red-300"
              title="New shapes on this layer with nothing cured under them — likely to fail or float">
              ⚠ {islandsHere.count} unsupported
            </span>
          )}
          {peelHere && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-500/20 text-orange-300"
              title="Cured area jumps sharply here — higher peel force">
              ↑ peel jump
            </span>
          )}
          {meta && <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${PHASE_STYLE[meta.phase] ?? "bg-slate-700"}`}>{meta.phase}</span>}
        </span>
      </div>

      <div className="relative bg-black rounded overflow-hidden flex-1 min-h-[80px] flex items-center justify-center">
        {shown
          ? <div className="absolute inset-0 flex items-center justify-center">
              <div className="relative h-full max-w-full" style={{ aspectRatio: `${aspect}` }}>
                <img src={shown} className="w-full h-full object-contain" />
                {islandsHere?.pts.map((p, k) => (
                  <span key={k} className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-red-500 pointer-events-none"
                    style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />
                ))}
              </div>
            </div>
          : <span className="text-[10px] text-slate-500 px-2 text-center">
              {state.state === "downloading" ? `Downloading file${pct != null ? ` ${pct}%` : ""}…`
               : state.state === "failed" ? "Couldn't download file"
               : state.state === "unsupported" ? "Only .goo files"
               : state.state === "none" ? "Select a file to preview its layers" : "Loading…"}
            </span>}
        {live && shown && <span className="absolute top-1 left-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
      </div>

      {/* layer slider — slim track inside the card; while printing it shows progress and is locked */}
      {state.state === "ready" && total > 1 && (
        <div className="mt-2 flex items-center gap-3">
          <input type="range" min={1} max={total} value={layer} disabled={live}
            onChange={e => onScrub(Number(e.target.value))}
            style={{ background: `linear-gradient(to right, #3b82f6 ${((layer - 1) / (total - 1)) * 100}%, #334155 ${((layer - 1) / (total - 1)) * 100}%)` }}
            className="flex-1 h-1 rounded-full appearance-none cursor-pointer disabled:cursor-default focus:outline-none
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-400
              [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-slate-900
              [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full
              [&::-moz-range-thumb]:bg-blue-400 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-slate-900" />
          <span className="text-[11px] text-gray-400 tabular-nums shrink-0">{Math.round(((layer - 1) / (total - 1)) * 100)}%</span>
        </div>
      )}

      {/* values for this layer */}
      {meta && (
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-0.5 text-xs">
          <span><span className="text-gray-400">Z </span><span className="text-green-400 font-semibold">{meta.z_mm.toFixed(2)} mm</span></span>
          <span><span className="text-gray-400">Exposure </span><span className="text-green-400 font-semibold">{meta.exposure_s} s</span></span>
          <span><span className="text-gray-400">Wait </span><span className="text-green-400 font-semibold">{meta.wait_before_cure_s} s</span></span>
          <span><span className="text-gray-400">Area </span><span className="text-green-400 font-semibold">{fmtArea(meta.area_mm2)}</span></span>
          {live && lastDone && (
            <span title="How long the last finished layer actually took vs the file's plan">
              <span className="text-gray-400">Layer time </span>
              <span className={`font-semibold ${planOf(lastDone[0]) != null && lastDone[1] > 1.5 * (planOf(lastDone[0]) ?? 0) ? "text-yellow-400" : "text-green-400"}`}>
                {lastDone[1].toFixed(1)}s
              </span>
              {planOf(lastDone[0]) != null && <span className="text-gray-400"> / plan {planOf(lastDone[0])!.toFixed(1)}s</span>}
            </span>
          )}
          {live && drift != null && (
            <span title="Actual minus planned time over the tracked layers">
              <span className="text-gray-400">Drift </span>
              <span className={`font-semibold ${drift > 60 ? "text-yellow-400" : "text-green-400"}`}>
                {drift >= 0 ? "+" : "−"}{fmtSec(drift)}
              </span>
            </span>
          )}
        </div>
      )}

    </div>
  )
}

function fmtArea(v: number) {
  return v >= 1000 ? `${(v / 1000).toFixed(2)}k mm²` : `${v.toFixed(1)} mm²`
}

function AreaProfileChart({ filename, ready, profile, layer, live, onScrub }: {
  filename: string; ready: boolean; profile: AreaProfile; layer: number; live: boolean; onScrub: (n: number) => void
}) {
  // ~600 points (max per bucket) keeps the chart light without hiding peaks
  const points = React.useMemo(() => {
    const a = profile.areas
    if (!a?.length) return []
    const n = Math.min(600, a.length)
    const out: { layer: number; area: number }[] = []
    for (let b = 0; b < n; b++) {
      const lo = Math.floor((b * a.length) / n), hi = Math.max(lo + 1, Math.floor(((b + 1) * a.length) / n))
      let m = 0, at = lo
      for (let k = lo; k < hi; k++) if (a[k] > m) { m = a[k]; at = k }
      out.push({ layer: at + 1, area: m })
    }
    return out
  }, [profile.areas])

  const current = profile.areas?.[layer - 1]
  const islandLayers = profile.islands?.map(i => i.layer) ?? []
  const peel = profile.peel ?? []
  const nextAfter = (list: number[]) => list.find(l => l > layer) ?? list[0]

  // "time to any layer": from now while printing, else time into the print
  const timeTo = (target: number) => {
    const cum = profile.cum_s
    if (!cum || target < 1 || target > cum.length) return null
    if (live) {
      if (target <= layer) return "already printed"
      const sec = cum[target - 1] - cum[Math.max(0, layer - 1)]
      const at = new Date(Date.now() + sec * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      return `reached ~${at} (in ${fmtDuration(sec)})`
    }
    return `${fmtDuration(cum[target - 1])} into the print`
  }
  const TipBox = ({ active, label }: { active?: boolean; label?: number }) => {
    if (!active || label == null || !profile.areas) return null
    const l = Number(label)
    const isl = profile.islands?.find(i => i.layer === l)
    return (
      <div className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs shadow">
        <p className="text-slate-200 font-semibold">Layer {l}</p>
        <p className="text-blue-300">{fmtArea(profile.areas[l - 1] ?? 0)}</p>
        {timeTo(l) && <p className="text-slate-400">{timeTo(l)}</p>}
        {isl && <p className="text-red-300">⚠ {isl.count} unsupported island{isl.count > 1 ? "s" : ""}</p>}
        {peel.includes(l) && <p className="text-orange-300">↑ peel jump</p>}
      </div>
    )
  }

  const msg = !filename ? "Select a .goo file to see cured area per layer"
    : !ready ? "Waiting for file…"
    : profile.state === "computing" ? `Calculating layer areas${profile.total ? ` ${Math.round(((profile.done ?? 0) / profile.total) * 100)}%` : ""}…`
    : profile.state === "failed" ? "Couldn't calculate layer areas" : null

  return (
    <div className="bg-slate-800 p-3 rounded flex flex-col h-[200px] lg:h-auto lg:flex-1 lg:min-h-[140px]">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-sm">Cured Area per Layer</h3>
        <span className="flex items-center gap-4 text-xs text-gray-400">
          {current != null && <span title="Cured (hardened) area of the layer shown">Layer {layer}: <span className="text-blue-300 font-semibold">{fmtArea(current)}</span></span>}
          {islandLayers.length > 0 && (
            <button disabled={live} onClick={() => onScrub(nextAfter(islandLayers))}
              className="text-red-300 hover:text-red-200 disabled:hover:text-red-300" title="Jump to the next layer with unsupported islands">
              ⚠ {islandLayers.length} island layer{islandLayers.length > 1 ? "s" : ""}
            </button>
          )}
          {peel.length > 0 && (
            <button disabled={live} onClick={() => onScrub(nextAfter(peel))}
              className="text-orange-300 hover:text-orange-200 disabled:hover:text-orange-300" title="Jump to the next sharp area jump">
              ↑ {peel.length} peel jump{peel.length > 1 ? "s" : ""}
            </button>
          )}
          {profile.state === "ready" && islandLayers.length === 0 && peel.length === 0 && (
            <span className="text-green-400/80" title="No unsupported islands or sharp area jumps found">✓ no islands</span>
          )}
          {profile.max_layer != null && (
            <button disabled={live} onClick={() => onScrub(profile.max_layer!)}
              className="hover:text-slate-200 disabled:hover:text-gray-400" title={live ? "" : "Jump to largest layer"}>
              Largest: <span className="text-orange-300 font-semibold">#{profile.max_layer} · {fmtArea(profile.max_area ?? 0)}</span>
            </button>
          )}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        {msg ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500">{msg}</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              onClick={(e: any) => { if (!live && e?.activeLabel) onScrub(Number(e.activeLabel)) }}
              style={{ cursor: live ? "default" : "pointer" }}>
              <CartesianGrid stroke="#334155" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="layer" type="number" domain={[1, profile.areas?.length ?? 1]}
                tick={{ fill: "#94a3b8", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "#475569" }} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} tickLine={false} axisLine={false} width={48}
                tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`} />
              <Tooltip content={<TipBox />} />
              <Area type="monotone" dataKey="area" stroke="#60a5fa" strokeWidth={1.5} fill="#3b82f6" fillOpacity={0.2}
                isAnimationActive={false} />
              {profile.max_layer != null && (
                <ReferenceLine x={profile.max_layer} stroke="#fb923c" strokeDasharray="4 3" />
              )}
              {islandLayers.slice(0, 80).map(l => (
                <ReferenceLine key={`i${l}`} x={l} stroke="#ef4444" strokeOpacity={0.7} />
              ))}
              {peel.slice(0, 80).map(l => (
                <ReferenceLine key={`p${l}`} x={l} stroke="#f59e0b" strokeOpacity={0.6} strokeDasharray="2 2" />
              ))}
              <ReferenceLine x={layer} stroke={live ? "#ef4444" : "#e2e8f0"} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

function BuildHeight({ currentMm, modelMm, machineMm }: { currentMm: number; modelMm: number; machineMm: number }) {
  // Side view: plate travels up; model column grows downward from the plate.
  const H = 100
  const scale = (mm: number) => Math.min(H, (mm / machineMm) * H)
  const built = scale(currentMm), model = scale(modelMm)
  const pct = modelMm > 0 ? Math.min(100, (currentMm / modelMm) * 100) : 0
  return (
    <div className="bg-slate-800 p-3 rounded w-full md:w-32 shrink-0 flex md:flex-col items-center gap-2 min-h-0">
      <h3 className="text-sm md:self-start">Build</h3>
      <svg viewBox="0 0 40 110" preserveAspectRatio="xMidYMid meet" className="h-24 md:h-auto md:w-full md:flex-1 min-h-0">
        <rect x="6" y="4" width="28" height={H} rx="2" fill="#0f172a" stroke="#334155" />
        {/* full model height (ghost) */}
        <rect x="12" y={4 + H - model} width="16" height={model} fill="#334155" />
        {/* printed so far */}
        <rect x="12" y={4 + H - built} width="16" height={built} fill="#22c55e" />
        {/* plate */}
        <rect x="8" y={4 + H - built - 2} width="24" height="2.5" fill="#94a3b8" />
      </svg>
      <div className="text-xs text-center leading-tight">
        <p className="text-green-400 font-semibold">{currentMm.toFixed(1)} mm</p>
        <p className="text-slate-400">of {modelMm ? `${modelMm} mm` : "--"}</p>
        {modelMm > 0 && <p className="text-slate-500">{pct.toFixed(0)}%</p>}
      </div>
    </div>
  )
}

// ───────────────────────── Logs window: reports · timelapse · maintenance ─────────────────────────
type Report = {
  task_id: string; file: string; result: string; started: number; ended: number; duration_s: number
  partial_tracking: boolean; progress: number; layers_done: number; layers_total: number | null
  resin_used_ml: number | null; vat_before_ml: number | null; vat_after_ml: number | null
  largest_layer: number | null; largest_area_mm2: number | null; unsupported_island_layers: number
  peel_jumps: number; max_error: number; avg_layer_s: number | null; planned_avg_layer_s: number | null
  slowest_layer_s: number | null
}
type MaintEntry = { t: number; type: string; note: string; film_count: number }
type Maint = {
  entries: MaintEntry[]; types: Record<string, string>; vat_clean_every: number
  prints_since_vat_clean: number; film_used: number; film_max: number
  reminders: { type: string; level: string; text: string }[]
}
type HistoryJob = { task_id: string; name: string; begin: number; end: number; status: string; timelapse_url: string | null }

function ResinLogs({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"reports" | "timelapse" | "maintenance">("reports")
  const [reports, setReports] = useState<Report[] | null>(null)
  const [jobs, setJobs] = useState<HistoryJob[] | null>(null)
  const [jobsErr, setJobsErr] = useState<string | null>(null)
  const [maint, setMaint] = useState<Maint | null>(null)
  const [kind, setKind] = useState("vat_clean")
  const [note, setNote] = useState("")
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    if (tab === "reports" && reports == null)
      fetch(`${API_URL}/resin/reports`).then(r => r.json()).then(j => setReports(j.items ?? [])).catch(() => setReports([]))
    if (tab === "timelapse" && jobs == null)
      fetch(`${API_URL}/resin/history?limit=30`).then(async r => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.detail ?? r.statusText)
        setJobs(j.items ?? [])
      }).catch(e => { setJobs([]); setJobsErr(String(e.message ?? e)) })
    if (tab === "maintenance" && maint == null)
      fetch(`${API_URL}/resin/maintenance`).then(r => r.json()).then(setMaint).catch(() => {})
  }, [tab])

  const maintPost = async (q: string) => {
    const r = await fetch(`${API_URL}/resin/maintenance?${q}`, { method: "POST" })
    if (r.ok) { setMaint(await r.json()); setNote("") }
  }
  const maintDelete = async (t: number) => {
    const r = await fetch(`${API_URL}/resin/maintenance?t=${t}`, { method: "DELETE" })
    if (r.ok) setMaint(await r.json())
    setPendingDelete(null)
  }
  const when = (sec: number) => new Date(sec * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
  const resultStyle: Record<string, string> = {
    finished: "bg-green-500/20 text-green-300", completed: "bg-green-500/20 text-green-300",
    stopped: "bg-yellow-500/20 text-yellow-300", failed: "bg-red-500/20 text-red-300",
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[min(860px,calc(100vw-2rem))] max-h-[min(640px,calc(100vh-2rem))] flex flex-col rounded bg-slate-900 border border-slate-700 shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-700 px-4 pt-3">
          <div className="flex gap-1">
            {(["reports", "timelapse", "maintenance"] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm rounded-t ${tab === t ? "bg-slate-800 text-slate-100" : "text-gray-400 hover:text-slate-200"}`}>
                {t === "reports" ? "Print Reports" : t === "timelapse" ? "Timelapse" : "Maintenance"}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-slate-100 text-xl leading-none pb-2">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "reports" && (
            reports == null ? <p className="text-sm text-gray-400">Loading…</p>
            : reports.length === 0 ? <p className="text-sm text-gray-400">No reports yet — one is saved automatically when a print finishes or stops.</p>
            : <div className="flex flex-col gap-2">
                {reports.map(r => (
                  <div key={`${r.task_id}${r.ended}`} className="bg-slate-800 rounded p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold truncate" title={r.file}>{r.file}</p>
                      <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-semibold ${resultStyle[r.result] ?? "bg-slate-700"}`}>{r.result.toUpperCase()}</span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {when(r.started)} → {when(r.ended)} · {fmtDuration(r.duration_s)}
                      {r.partial_tracking && " · tracked from mid-print"}
                    </p>
                    <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                      <span><span className="text-gray-400">Layers </span>{r.layers_done}/{r.layers_total ?? "--"} ({r.progress}%)</span>
                      <span><span className="text-gray-400">Resin </span>{r.resin_used_ml != null ? `${r.resin_used_ml} ml` : "--"}</span>
                      <span><span className="text-gray-400">Vat </span>{r.vat_before_ml != null ? `${Math.round(r.vat_before_ml)} → ${Math.round(r.vat_after_ml ?? 0)} ml` : "--"}</span>
                      <span><span className="text-gray-400">Errors </span>{r.max_error || "none"}</span>
                      <span><span className="text-gray-400">Avg layer </span>{r.avg_layer_s != null ? `${r.avg_layer_s}s` : "--"}{r.planned_avg_layer_s != null && ` (plan ${r.planned_avg_layer_s}s)`}</span>
                      <span><span className="text-gray-400">Slowest </span>{r.slowest_layer_s != null ? `${r.slowest_layer_s}s` : "--"}</span>
                      <span><span className="text-gray-400">Largest </span>{r.largest_layer ? `#${r.largest_layer} · ${fmtArea(r.largest_area_mm2 ?? 0)}` : "--"}</span>
                      <span><span className="text-gray-400">Risks </span>{r.unsupported_island_layers} island · {r.peel_jumps} peel</span>
                    </div>
                  </div>
                ))}
              </div>
          )}

          {tab === "timelapse" && (
            jobs == null ? <p className="text-sm text-gray-400">Loading from printer…</p>
            : jobsErr ? <p className="text-sm text-red-400">Couldn't read print history from the printer: {jobsErr}</p>
            : jobs.length === 0 ? <p className="text-sm text-gray-400">No print history on the printer.</p>
            : <div className="flex flex-col divide-y divide-slate-800">
                {jobs.map(j => (
                  <div key={j.task_id} className="flex items-center gap-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate" title={j.name}>{j.name || "Unnamed job"}</p>
                      <p className="text-xs text-gray-400">{j.begin ? when(j.begin) : "--"}</p>
                    </div>
                    <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] ${resultStyle[j.status] ?? "bg-slate-700 text-slate-300"}`}>{j.status}</span>
                    {j.timelapse_url
                      ? <a href={j.timelapse_url} target="_blank" rel="noreferrer" download
                          className="shrink-0 text-xs bg-slate-800 hover:bg-slate-700 rounded px-3 py-1 text-blue-300">Download video</a>
                      : <span className="shrink-0 text-xs text-slate-500 w-[118px] text-right">No video</span>}
                  </div>
                ))}
              </div>
          )}

          {tab === "maintenance" && (
            maint == null ? <p className="text-sm text-gray-400">Loading…</p>
            : <div className="flex flex-col gap-4">
                {maint.reminders.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {maint.reminders.map((r, k) => (
                      <p key={k} className={`text-sm rounded px-3 py-2 ${r.level === "due" ? "bg-red-500/10 text-red-300" : "bg-yellow-500/10 text-yellow-300"}`}>⚠ {r.text}</p>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                  <div className="bg-slate-800 rounded p-3 text-center">
                    <p className="text-xs text-gray-400">Release film</p>
                    <p className="font-semibold text-green-400">{maint.film_used.toLocaleString()} / {maint.film_max.toLocaleString()}</p>
                  </div>
                  <div className="bg-slate-800 rounded p-3 text-center">
                    <p className="text-xs text-gray-400">Prints since vat clean</p>
                    <p className="font-semibold text-green-400">{maint.prints_since_vat_clean} / {maint.vat_clean_every}</p>
                  </div>
                  <div className="bg-slate-800 rounded p-3 text-center col-span-2 sm:col-span-1">
                    <p className="text-xs text-gray-400">Clean vat every</p>
                    <select value={maint.vat_clean_every} onChange={e => maintPost(`kind=settings&vat_clean_every=${e.target.value}`)}
                      className="mt-0.5 bg-slate-900 rounded px-2 py-0.5 font-semibold text-green-400">
                      {[3, 5, 10, 15, 20, 30].map(n => <option key={n} value={n}>{n} prints</option>)}
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select value={kind} onChange={e => setKind(e.target.value)} className="bg-slate-800 rounded px-2 py-1.5 text-sm">
                    {Object.entries(maint.types).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                  <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)"
                    className="flex-1 min-w-[160px] bg-slate-800 rounded px-2 py-1.5 text-sm" />
                  <button onClick={() => maintPost(`kind=${kind}&note=${encodeURIComponent(note)}`)}
                    className="bg-slate-700 hover:bg-slate-600 rounded px-3 py-1.5 text-sm">Log</button>
                </div>

                <div className="flex flex-col divide-y divide-slate-800">
                  {maint.entries.length === 0 && <p className="text-sm text-gray-400">Nothing logged yet.</p>}
                  {maint.entries.map(e => (
                    <div key={e.t} className="flex items-center gap-3 py-2 text-sm">
                      <span className="text-xs text-gray-400 w-32 shrink-0">{when(e.t)}</span>
                      <span className="flex-1 min-w-0 truncate">
                        {maint.types[e.type] ?? e.type}{e.note && <span className="text-gray-400"> — {e.note}</span>}
                      </span>
                      <span className="text-xs text-gray-500 shrink-0">film {e.film_count.toLocaleString()}</span>
                      {pendingDelete === e.t
                        ? <span className="shrink-0 text-xs">
                            <button onClick={() => maintDelete(e.t)} className="text-red-400 hover:text-red-300 mr-2">Delete</button>
                            <button onClick={() => setPendingDelete(null)} className="text-gray-400 hover:text-slate-200">Cancel</button>
                          </span>
                        : <button onClick={() => setPendingDelete(e.t)} className="shrink-0 text-gray-500 hover:text-red-400" title="Delete entry">✕</button>}
                    </div>
                  ))}
                </div>
              </div>
          )}
        </div>
      </div>
    </div>
  )
}

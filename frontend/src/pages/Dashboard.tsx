// src/pages/Dashboard.tsx
import { useState, useCallback, useEffect } from "react"
import FDM from "../printers/FDMPrinter"
import Resin from "../printers/ResinPrinter"
import PocketNC from "../printers/PocketNC"
import Scheduler from "./Scheduler"
import fdmImg from "../assets/fdm.jpg"
import resinImg from "../assets/resin.jpg"
import pocketImg from "../assets/pocketnc.jpg"
import HybridCellImg from "../assets/HybridCell.jpg"
import type { MachineId, MachineStatus, MachineSummary } from "../types/machine"

/* ----------------------------------------------------------------
   Machine roster.
-----------------------------------------------------------------*/
const MACHINES: { id: MachineId; name: string; subtitle: string; image?: string }[] = [
  { id: "FDM", name: "FDM", subtitle: "Klipper · Voron 2.4", image: fdmImg },
  { id: "Resin", name: "RESIN", subtitle: "SDCP · Saturn 4 Ultra", image: resinImg },
  { id: "PocketNC", name: "POCKETNC", subtitle: "5-axis Mill", image: pocketImg },
  { id: "Hybrid-Cell", name: "HYBRID_CELL", subtitle: "", image: HybridCellImg },
]

// Machines that have a working detail component. Others show a placeholder
// instead of a blank screen when opened.
const WIRED: MachineId[] = ["FDM", "Resin", "PocketNC"]

type NavPage = "overview" | "scheduler" | "mission" | "analytics" | "display"
const NAV: { id: NavPage; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "scheduler", label: "Scheduler" },
  { id: "mission", label: "Mission" },
  { id: "analytics", label: "Analytics" },
  { id: "display", label: "Display" },
]

const STATUS_STYLES: Record<MachineStatus, { text: string; label: string; borderL: string }> = {
  running: { text: "text-green-400", label: "RUNNING", borderL: "border-l-green-400" },
  idle: { text: "text-yellow-400", label: "IDLE", borderL: "border-l-yellow-400" },
  fault: { text: "text-red-400", label: "FAULT", borderL: "border-l-red-400" },
  offline: { text: "text-slate-500", label: "OFFLINE", borderL: "border-l-slate-600" },
  connecting: { text: "text-yellow-400", label: "CONNECTING", borderL: "border-l-yellow-400" },
}

// Shared column grid so the header labels line up with each row.
const COLS = "grid-cols-[2.4fr_1fr_1.2fr_1.4fr]"

// Read ?view=<page> from the URL. When present, this window is a popped-out
// single page: it renders that page only, with no top nav.
function readStandalone(): NavPage | null {
  const v = new URLSearchParams(window.location.search).get("view")
  return v && NAV.some((n) => n.id === v) ? (v as NavPage) : null
}

export default function Dashboard() {
  // If launched with ?view=, this window is locked to that single page.
  // Otherwise it's the main hub, which always shows the overview.
  const standalone = readStandalone()
  const page: NavPage = standalone ?? "overview"

  const [selected, setSelected] = useState<MachineId | null>(() => {
    if (standalone) return null // popped-out windows start clean
    const saved = localStorage.getItem("dashboard.selected") as MachineId | null
    return saved && MACHINES.some((m) => m.id === saved) ? saved : null
  })

  // Persist the open machine — but only in the main hub, so popped-out
  // windows can't clobber it.
  useEffect(() => {
    if (standalone) return
    if (selected) localStorage.setItem("dashboard.selected", selected)
    else localStorage.removeItem("dashboard.selected")
  }, [selected, standalone])

  // Give popped-out windows a useful tab title.
  useEffect(() => {
    if (!standalone) return
    const label = NAV.find((n) => n.id === standalone)?.label ?? standalone
    document.title = `${label} · Digital Twin`
  }, [standalone])

  // Connection lifting. Every MachineId must have a key. Unwired machines
  // start as `false` so they render OFFLINE rather than spinning forever.
  const [connections, setConnections] = useState<Record<MachineId, boolean | null>>({
    FDM: null,
    Resin: null,
    PocketNC: null,
    "Hybrid-Cell": false,
  })
  // Live summary (status / progress / temps) reported by each component.
  const [summaries, setSummaries] = useState<Record<MachineId, MachineSummary | null>>({
    FDM: null,
    Resin: null,
    PocketNC: null,
    "Hybrid-Cell": null,
  })

  const setConnection = useCallback((id: MachineId, value: boolean | null) => {
    setConnections((c) => (c[id] === value ? c : { ...c, [id]: value }))
  }, [])
  const setSummary = useCallback((id: MachineId, s: MachineSummary) => {
    setSummaries((m) => ({ ...m, [id]: s }))
  }, [])

  // Prefer the machine's own reported status; fall back to its connection state
  // so rows still render meaningfully before any summary arrives.
  const statusOf = (id: MachineId): MachineStatus => {
    const s = summaries[id]
    if (s) return s.status
    const c = connections[id]
    if (c === null) return "connecting"
    if (c === false) return "offline"
    return "idle"
  }

  const running = MACHINES.filter((m) => statusOf(m.id) === "running").length
  const idle = MACHINES.filter((m) => statusOf(m.id) === "idle").length
  const down = MACHINES.filter((m) => ["fault", "offline"].includes(statusOf(m.id))).length

  // Each nav tab opens that page in its own window (one window per page,
  // reused on repeat clicks) and returns the hub to the fleet list.
  const openPage = (p: NavPage) => {
    const url = new URL(window.location.href)
    url.searchParams.set("view", p)
    window.open(url.toString(), `dtdash-${p}`)
    setSelected(null)
  }

  const pageLabel = NAV.find((n) => n.id === page)?.label ?? page
  const openUnwired = selected !== null && !WIRED.includes(selected)

  // Machine components (and their WebSockets) only mount on the overview, so
  // popped-out scheduler/analytics windows don't open extra connections.
  const mountMachines = page === "overview"

  return (
    <div className="h-screen bg-slate-900 text-gray-200 flex flex-col overflow-hidden">
      {/* ---------------- TOP NAV BAR (hub window only) ---------------- */}
      {!standalone && (
        <header className="shrink-0 bg-slate-900 border-b border-slate-700 px-4 sm:px-6">
          <div className="h-14 sm:h-16 flex items-center justify-between gap-4">
            <nav className="flex items-center gap-4 sm:gap-6 text-sm overflow-x-auto whitespace-nowrap">
              {NAV.map((t) => (
                <button
                  key={t.id}
                  onClick={() => openPage(t.id)}
                  className={`shrink-0 pb-1 border-b-2 transition-colors ${
                    page === t.id
                      ? "text-green-400 border-green-400"
                      : "text-slate-400 border-transparent hover:text-gray-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            {/* Live fleet status — visible on every page. */}
            <div className="flex items-center gap-3 sm:gap-4 text-sm text-slate-400 shrink-0">
              <StatusCount color="bg-green-400" count={running} word="running" />
              <StatusCount color="bg-yellow-400" count={idle} word="idle" />
              {down > 0 && <StatusCount color="bg-red-400" count={down} word="down" />}
            </div>
          </div>
        </header>
      )}

      {/* ---------------- FLEET OVERVIEW ---------------- */}
      {page === "overview" && selected === null && (
        <div className="flex-1 overflow-auto">
          <div className="px-4 sm:px-6 py-5">
            <div className="mb-4">
              <h1 className="text-lg font-semibold text-white">Live machine status</h1>
              <p className="text-sm text-blue-400">All machines — real-time</p>
            </div>

            {/* Column labels — desktop only; each mobile row carries its own inline labels */}
            <div className={`hidden md:grid ${COLS} gap-4 px-4 pb-2 text-xs tracking-wide text-slate-500`}>
              <span>MACHINE</span>
              <span>STATUS</span>
              <span>PROGRESS</span>
              <span>TEMPERATURE</span>
            </div>

            {MACHINES.map((m) => (
              <MachineRow
                key={m.id}
                machine={m}
                status={statusOf(m.id)}
                summary={summaries[m.id]}
                onOpen={() => setSelected(m.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ---------------- OPENED A MACHINE WITHOUT A DETAIL VIEW ---------------- */}
      {page === "overview" && openUnwired && (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
          <div className="text-2xl mb-1">{MACHINES.find((m) => m.id === selected)?.name}</div>
          <div className="text-sm">Detail view not available yet.</div>
        </div>
      )}

      {/* ---------------- SCHEDULER ---------------- */}
      {page === "scheduler" && (
        <div className="flex-1 overflow-auto">
          <Scheduler />
        </div>
      )}

      {/* ---------------- OTHER NAV PAGES (placeholders) ---------------- */}
      {page !== "overview" && page !== "scheduler" && (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
          <div className="text-2xl mb-1">{pageLabel}</div>
          <div className="text-sm">This page isn’t built yet.</div>
        </div>
      )}

      {/* ----------------------------------------------------------------
          Machine components stay mounted while on the overview so their
          WebSocket connections + telemetry keep flowing into the fleet view.
          They are only shown when their detail view is open.
      -----------------------------------------------------------------*/}
      {mountMachines && (
        <>
          <div className={selected === "FDM" ? "flex-1 overflow-auto" : "hidden"}>
            <FDM
              onConnectionChange={(v) => setConnection("FDM", v)}
              onSummary={(s) => setSummary("FDM", s)}
            />
          </div>
          <div className={selected === "Resin" ? "flex-1 overflow-auto" : "hidden"}>
            <Resin
              onConnectionChange={(v) => setConnection("Resin", v)}
              onSummary={(s) => setSummary("Resin", s)}
            />
          </div>
          <div className={selected === "PocketNC" ? "flex-1 overflow-auto" : "hidden"}>
            <PocketNC
              onConnectionChange={(v) => setConnection("PocketNC", v)}
              onSummary={(s) => setSummary("PocketNC", s)}
            />
          </div>
        </>
      )}
    </div>
  )
}

/* ============================ subcomponents ============================ */

function StatusCount({ color, count, word }: { color: string; count: number; word: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span>
        {count}
        <span className="hidden sm:inline"> {word}</span>
      </span>
    </span>
  )
}

function StatusPill({ status }: { status: MachineStatus }) {
  const s = STATUS_STYLES[status]
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-medium ${s.text}`}>
      {status === "connecting" && (
        <span className="w-3 h-3 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
      )}
      {s.label}
    </span>
  )
}

function MachineRow({
  machine,
  status,
  summary,
  onOpen,
}: {
  machine: { id: MachineId; name: string; subtitle: string; image?: string }
  status: MachineStatus
  summary: MachineSummary | null
  onOpen: () => void
}) {
  const s = STATUS_STYLES[status]
  const isRunning = status === "running"

  return (
    <button
      onClick={onOpen}
      className={`w-full text-left flex flex-col gap-3 md:grid md:grid-cols-[2.4fr_1fr_1.2fr_1.4fr] md:items-center md:gap-4 mb-3 px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 border-l-2 ${s.borderL} hover:border-slate-500 transition-colors`}
    >
      {/* MACHINE — image + name */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-24 h-24 shrink-0 rounded-md bg-slate-900 border border-slate-700 overflow-hidden flex items-center justify-center">
          {machine.image ? (
            <img src={machine.image} alt={machine.name} className="w-full h-full object-cover" />
          ) : (
            <span className="text-slate-600 text-xs">image</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-gray-100 font-medium text-sm truncate">{machine.name}</div>
          <div className="text-slate-500 text-xs truncate">{machine.subtitle}</div>
        </div>
      </div>

      {/* STATUS */}
      <div className="flex items-center justify-between md:block">
        <span className="text-xs text-slate-500 md:hidden">Status</span>
        <StatusPill status={status} />
      </div>

      {/* PROGRESS */}
      <div className="flex items-center justify-between md:block">
        <span className="text-xs text-slate-500 md:hidden">Progress</span>
        {isRunning && summary?.progress != null ? (
          <div className="text-right md:text-left">
            <div className="text-green-400 font-medium text-base">
              {Math.round(summary.progress)}%
            </div>
            <div className="h-1 w-16 bg-slate-900 rounded mt-1 ml-auto md:ml-0">
              <div
                className="h-full bg-green-400 rounded"
                style={{ width: `${summary.progress}%` }}
              />
            </div>
          </div>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </div>

      {/* TEMPERATURE */}
      <div className="flex items-center justify-between gap-3 md:block">
        <span className="text-xs text-slate-500 md:hidden shrink-0">Temp</span>
        {summary?.temps?.length ? (
          <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 text-xs md:justify-start">
            {summary.temps.map((t) => (
              <span key={t.label} className="text-slate-400">
                {t.label}{" "}
                <span className="text-gray-200">
                  {t.value != null ? `${t.value}${t.unit ?? "°C"}` : "—"}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </div>
    </button>
  )
}
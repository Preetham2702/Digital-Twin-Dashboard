// src/pages/Scheduler.tsx
// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION SCHEDULER DASHBOARD — working demo with mock ("test") data.
//
// There's no backend here. A simulated MES feed (setInterval) mutates seed data
// on each refresh: order progress creeps up and completes, today's output
// climbs, machine utilization jitters, the bottleneck + alerts recompute, and a
// live clock advances the "now" line on the Gantt. Every KPI / donut / count is
// DERIVED from that live state, so the whole board reacts.
//
// Interactive: order-status filter, expand/collapse (View All), Gantt block
// selection, pause + refresh-interval controls (footer).
//
// Tunables live in the CONFIG + SEED blocks near the top.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts"

/* ============================================================
   CONFIG
============================================================ */

const SIM_SPEED = 1 // sim-seconds advanced per real second. Bump (e.g. 30) to fast-forward the day.
const BOTTLENECK_THRESHOLD = 95 // % utilization that flags a machine as a bottleneck

type SchedStatus = "running" | "planned" | "waiting" | "delayed" | "completed" | "idle"
type OrderStatus = "Running" | "Delayed" | "Completed"

const STATUS_COLOR: Record<SchedStatus, string> = {
  running: "#22c55e",
  planned: "#3b82f6",
  waiting: "#f59e0b",
  delayed: "#ef4444",
  completed: "#8b5cf6",
  idle: "#64748b",
}

const LEGEND: { status: SchedStatus; label: string }[] = [
  { status: "running", label: "Running" },
  { status: "planned", label: "Planned" },
  { status: "waiting", label: "Waiting" },
  { status: "delayed", label: "Delayed" },
  { status: "completed", label: "Completed" },
  { status: "idle", label: "Idle" },
]

const ORDER_STATUS_COLOR: Record<OrderStatus, string> = {
  Running: "#22c55e",
  Delayed: "#ef4444",
  Completed: "#8b5cf6",
}

/* ============================================================
   SEED ("test") DATA
============================================================ */

interface Order {
  id: string
  progress: number
  due: string
  status: OrderStatus
}

const SEED_ORDERS: Order[] = [
  { id: "P001", progress: 72, due: "20 May 11:30 AM", status: "Running" },
  { id: "P002", progress: 45, due: "20 May 03:00 PM", status: "Running" },
  { id: "P003", progress: 90, due: "20 May 01:00 PM", status: "Running" },
  { id: "P004", progress: 20, due: "20 May 05:00 PM", status: "Delayed" },
  { id: "P005", progress: 65, due: "20 May 03:00 PM", status: "Running" },
  { id: "P006", progress: 35, due: "20 May 04:00 PM", status: "Running" },
  { id: "P007", progress: 10, due: "20 May 05:30 PM", status: "Running" },
  { id: "P008", progress: 55, due: "20 May 02:30 PM", status: "Running" },
  { id: "P009", progress: 80, due: "20 May 04:30 PM", status: "Running" },
  { id: "P010", progress: 30, due: "20 May 06:00 PM", status: "Completed" },
]

interface Util {
  m: string
  pct: number
}
const SEED_UTIL: Util[] = [
  { m: "M1", pct: 85 },
  { m: "M2", pct: 92 },
  { m: "M3", pct: 97 },
  { m: "M4", pct: 42 },
  { m: "M5", pct: 61 },
  { m: "M6", pct: 33 },
]

const DUE: { id: string; time: string }[] = [
  { id: "P001", time: "11:30 AM" },
  { id: "P003", time: "01:00 PM" },
  { id: "P005", time: "03:00 PM" },
  { id: "P009", time: "04:30 PM" },
  { id: "P002", time: "03:00 PM" },
  { id: "P008", time: "02:30 PM" },
]

const RELEASES: { time: string; part: string; to: string }[] = [
  { time: "10:00 AM", part: "P001 Part-E", to: "M5" },
  { time: "10:20 AM", part: "P006 Part-B", to: "M4" },
  { time: "10:45 AM", part: "P007 Part-A", to: "M1" },
  { time: "11:00 AM", part: "Assembly P001", to: "ASY-01" },
  { time: "11:30 AM", part: "P005 Part-C", to: "M6" },
  { time: "12:00 PM", part: "P008 Part-D", to: "M3" },
]

// ── Machine schedule (Gantt). Times are decimal hours (9.5 = 09:30). ──
const DAY_START = 0 // 12:00 AM
const DAY_END = 12 // 12:00 PM
const PX_PER_HOUR = 92 // fallback scale before the viewport is measured
const VISIBLE_HOURS = 6 // hours shown in the viewport; the rest of the day scrolls
const HOURS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const MACHINES = ["M1", "M2", "M3", "M4", "M5", "M6"]

interface Task {
  machine: string
  label: string
  start: number
  end: number
  status: SchedStatus
  color?: string
}

const TASKS: Task[] = [
  // M1
  { machine: "M1", label: "P001-A", start: 1.0, end: 3.0, status: "running" },
  { machine: "M1", label: "P004-C", start: 3.0, end: 5.0, status: "waiting" },
  { machine: "M1", label: "P007-A", start: 5.0, end: 7.0, status: "completed" },
  { machine: "M1", label: "P010-B", start: 8.0, end: 10.5, status: "planned" },
  // M2
  { machine: "M2", label: "P002-B", start: 0.5, end: 2.5, status: "planned" },
  { machine: "M2", label: "P002-B", start: 2.5, end: 4.5, status: "planned" },
  { machine: "M2", label: "P005-A", start: 5.0, end: 7.0, status: "waiting" },
  { machine: "M2", label: "P009-A", start: 8.0, end: 10.0, status: "waiting" },
  // M3
  { machine: "M3", label: "P001-C", start: 2.0, end: 4.0, status: "delayed" },
  { machine: "M3", label: "P001-C", start: 4.0, end: 6.0, status: "delayed" },
  { machine: "M3", label: "P008-D", start: 7.0, end: 9.5, status: "planned", color: "#0d9488" },
  { machine: "M3", label: "P012-A", start: 9.5, end: 11.5, status: "planned" },
  // M4
  { machine: "M4", label: "P003-D", start: 0.0, end: 2.5, status: "completed" },
  { machine: "M4", label: "P006-B", start: 3.0, end: 5.0, status: "waiting" },
  { machine: "M4", label: "P010-A", start: 6.0, end: 8.0, status: "waiting" },
  { machine: "M4", label: "P011-A", start: 8.5, end: 11.0, status: "planned" },
  // M5
  { machine: "M5", label: "P001-E", start: 1.5, end: 4.5, status: "running" },
  { machine: "M5", label: "P001-E", start: 4.5, end: 7.0, status: "running" },
  { machine: "M5", label: "P002-C", start: 8.0, end: 10.5, status: "planned" },
  // M6
  { machine: "M6", label: "P005-C", start: 2.0, end: 4.5, status: "planned" },
  { machine: "M6", label: "P005-C", start: 4.5, end: 6.5, status: "planned" },
  { machine: "M6", label: "P006-D", start: 8.0, end: 10.0, status: "planned" },
]

const FILTERS: { id: "All" | OrderStatus; label: string }[] = [
  { id: "All", label: "All Orders" },
  { id: "Running", label: "Running" },
  { id: "Delayed", label: "Delayed" },
  { id: "Completed", label: "Completed" },
]

const REFRESH_OPTIONS = [2000, 5000, 10000, 30000] // ms

/* ============================================================
   HELPERS
============================================================ */

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))
const pad2 = (n: number) => String(n).padStart(2, "0")

function fmtClock(simSec: number) {
  const totalMin = Math.floor(simSec / 60)
  const h24 = Math.floor(totalMin / 60) % 24
  const m = totalMin % 60
  const s = Math.floor(simSec) % 60
  const ampm = h24 >= 12 ? "PM" : "AM"
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return {
    hm: `${pad2(h12)}:${pad2(m)} ${ampm}`,
    hms: `${pad2(h12)}:${pad2(m)}:${pad2(s)} ${ampm}`,
  }
}

function fmtHour(h: number) {
  const hh = h % 12 === 0 ? 12 : h % 12
  const ampm = h < 12 ? "AM" : "PM"
  return `${pad2(hh)}:00 ${ampm}`
}

// Decimal hours (e.g. 13.5) -> "01:30 PM" for the hover scrubber tooltip.
function hoursToLabel(t: number) {
  const totalMin = Math.round(t * 60)
  const h24 = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const ampm = h24 >= 12 ? "PM" : "AM"
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${pad2(h12)}:${pad2(m)} ${ampm}`
}

/* ============================================================
   MAIN COMPONENT
============================================================ */

export default function Scheduler() {
  // ── live simulated clock (drives header + Gantt "now" line) ──
  const [simSec, setSimSec] = useState(9 * 3600 + 42 * 60) // 09:42:00
  useEffect(() => {
    const id = setInterval(() => setSimSec((s) => (s + SIM_SPEED) % 86400), 1000)
    return () => clearInterval(id)
  }, [])

  // ── mutable "test" data ──
  const [orders, setOrders] = useState<Order[]>(SEED_ORDERS)
  const [util, setUtil] = useState<Util[]>(SEED_UTIL)
  const [output, setOutput] = useState(1250)
  const [onTime, setOnTime] = useState(93)
  const [wip, setWip] = useState(23)
  const [lastUpdated, setLastUpdated] = useState(fmtClock(simSec).hms)

  // ── controls ──
  const [paused, setPaused] = useState(false)
  const [refreshMs, setRefreshMs] = useState(2000)
  const [filter, setFilter] = useState<"All" | OrderStatus>("All")
  const [filterOpen, setFilterOpen] = useState(false)
  const [expand, setExpand] = useState({
    orders: false,
    alerts: false,
    releases: false,
    due: false,
    util: false, // toggles sort by % desc
    bottleneck: false,
  })
  const [selectedTask, setSelectedTask] = useState<string | null>(null)

  const toggle = (k: keyof typeof expand) => setExpand((e) => ({ ...e, [k]: !e[k] }))

  // ── the simulated MES refresh ──
  useEffect(() => {
    if (paused) return
    const id = setInterval(() => {
      setOrders((prev) =>
        prev.map((o) => {
          if (o.status === "Completed") return o
          if (o.status === "Delayed") {
            // delayed jobs barely move
            return { ...o, progress: clamp(o.progress + randInt(0, 1), 0, 99) }
          }
          let p = o.progress + randInt(1, 4)
          if (p >= 100) return { ...o, progress: 100, status: "Completed" }
          return { ...o, progress: p }
        })
      )
      setUtil((prev) => prev.map((u) => ({ ...u, pct: clamp(u.pct + randInt(-3, 3), 5, 99) })))
      setOutput((v) => v + randInt(2, 9))
      setOnTime((v) => clamp(v + randInt(-1, 1), 80, 99))
      setWip((v) => clamp(v + randInt(-1, 1), 10, 40))
      setLastUpdated(fmtClock(simSecRef.current).hms)
    }, refreshMs)
    return () => clearInterval(id)
  }, [paused, refreshMs])

  // keep a ref to simSec so the refresh interval can stamp "last updated"
  const simSecRef = useMemo(() => ({ current: simSec }), [])
  simSecRef.current = simSec

  /* ---------- derived values ---------- */

  const clock = fmtClock(simSec)
  const nowHours = clamp(simSec / 3600, DAY_START, DAY_END)
  const nowLabel = clock.hm

  const counts = useMemo(() => {
    const total = orders.length
    const running = orders.filter((o) => o.status === "Running").length
    const delayed = orders.filter((o) => o.status === "Delayed").length
    const completed = orders.filter((o) => o.status === "Completed").length
    return { total, running, delayed, completed }
  }, [orders])

  const overallUtil = useMemo(
    () => Math.round(util.reduce((a, u) => a + u.pct, 0) / util.length),
    [util]
  )

  const sortedUtil = useMemo(
    () => (expand.util ? [...util].sort((a, b) => b.pct - a.pct) : util),
    [util, expand.util]
  )

  const bottlenecks = useMemo(
    () => [...util].sort((a, b) => b.pct - a.pct),
    [util]
  )
  const topBottleneck = bottlenecks[0]
  const queueLen = useMemo(() => {
    const onMachine = TASKS.filter((t) => t.machine === topBottleneck.m).length
    return onMachine + 1
  }, [topBottleneck])

  const summary = useMemo(
    () => [
      { name: "Running", value: counts.running, color: ORDER_STATUS_COLOR.Running },
      { name: "Delayed", value: counts.delayed, color: ORDER_STATUS_COLOR.Delayed },
      { name: "Completed", value: counts.completed, color: ORDER_STATUS_COLOR.Completed },
    ],
    [counts]
  )

  const alerts = useMemo(() => {
    const list: { level: "red" | "amber" | "green"; text: string }[] = []
    orders
      .filter((o) => o.status === "Delayed")
      .forEach((o) => list.push({ level: "red", text: `${o.id} is behind schedule` }))
    util
      .filter((u) => u.pct >= BOTTLENECK_THRESHOLD)
      .forEach((u) => list.push({ level: "red", text: `Machine ${u.m} overloaded` }))
    list.push({ level: "amber", text: "Material low for P008" })
    const topRunning = [...orders]
      .filter((o) => o.status === "Running")
      .sort((a, b) => b.progress - a.progress)[0]
    if (topRunning) list.push({ level: "green", text: `${topRunning.id} on track` })
    return list
  }, [orders, util])

  const kpis = [
    { icon: "box", label: "TOTAL ORDERS", value: `${counts.total}`, color: "text-sky-400" },
    { icon: "play", label: "RUNNING", value: `${counts.running}`, color: "text-emerald-400" },
    { icon: "hourglass", label: "DELAYED", value: `${counts.delayed}`, color: "text-red-400" },
    { icon: "check", label: "COMPLETED", value: `${counts.completed}`, color: "text-green-400" },
    { icon: "gauge", label: "OVERALL UTILIZATION", value: `${overallUtil}%`, color: "text-cyan-400", highlight: true },
    { icon: "layers", label: "WIP (PARTS)", value: `${wip}`, color: "text-sky-400" },
    { icon: "bars", label: "TODAY'S OUTPUT (pcs)", value: output.toLocaleString(), color: "text-emerald-400" },
    { icon: "target", label: "ON-TIME DELIVERY", value: `${onTime}%`, color: "text-green-400" },
  ]

  // filtered + capped order list
  const filteredOrders = filter === "All" ? orders : orders.filter((o) => o.status === filter)
  const ORDERS_CAP = 7
  const visibleOrders = expand.orders ? filteredOrders : filteredOrders.slice(0, ORDERS_CAP)

  const visibleDue = expand.due ? DUE : DUE.slice(0, 4)
  const visibleReleases = expand.releases ? RELEASES : RELEASES.slice(0, 4)
  const visibleAlerts = expand.alerts ? alerts : alerts.slice(0, 4)
  const visibleBottlenecks = expand.bottleneck ? bottlenecks.slice(0, 3) : bottlenecks.slice(0, 1)

  /* ---------- render ---------- */

  return (
    <div className="min-h-full bg-slate-900 text-slate-200 px-4 sm:px-6 py-4 flex flex-col gap-4">
      {/* HEADER */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-green-400">
            <Icon name="factory" className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-white leading-tight">
              PRODUCTION SCHEDULER DASHBOARD
            </h1>
            <p className="text-xs text-slate-400">Real-time Overview of All Orders &amp; Machines</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right leading-tight">
            <div className="text-lg font-semibold text-white tabular-nums">{clock.hm}</div>
            <div className="text-xs text-slate-400">20 May 2025 | Tuesday</div>
          </div>


          {/* working order filter */}
          <div className="relative">
            <button
              onClick={() => setFilterOpen((o) => !o)}
              className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 flex items-center gap-2 hover:border-slate-500"
            >
              {FILTERS.find((f) => f.id === filter)?.label}
              <Icon name="chevron" className={`w-3 h-3 text-slate-400 transition-transform ${filterOpen ? "-rotate-90" : "rotate-90"}`} />
            </button>
            {filterOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 mt-1 w-40 z-50 rounded bg-slate-800 border border-slate-700 shadow-xl overflow-hidden">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        setFilter(f.id)
                        setFilterOpen(false)
                        setExpand((e) => ({ ...e, orders: false }))
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-700 ${
                        filter === f.id ? "text-green-400" : "text-slate-300"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* KPI ROW */}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      {/* MAIN 3-COLUMN ROW */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.85fr_1fr] gap-4">
        {/* ORDER STATUS */}
        <Card
          title="ORDER STATUS"
          actionLabel={
            filteredOrders.length > ORDERS_CAP ? (expand.orders ? "Show Less" : "View All") : undefined
          }
          onAction={() => toggle("orders")}
        >
          <OrdersTable orders={visibleOrders} />
          {filter !== "All" && (
            <p className="text-[11px] text-slate-500 mt-2">
              Showing {filteredOrders.length} {filter.toLowerCase()} order(s)
            </p>
          )}
        </Card>

        {/* MACHINE SCHEDULE */}
        <Card title="MACHINE SCHEDULE (TODAY)" actionLabel={undefined}>
          <Gantt
            nowHours={nowHours}
            nowLabel={nowLabel}
            selected={selectedTask}
            onSelect={(k) => setSelectedTask((cur) => (cur === k ? null : k))}
          />
        </Card>

        {/* UTIL + BOTTLENECK */}
        <div className="flex flex-col gap-4">
          <Card
            title="MACHINE UTILIZATION"
            actionLabel={expand.util ? "Default Order" : "Sort by %"}
            onAction={() => toggle("util")}
          >
            <Utilization rows={sortedUtil} />
          </Card>
          <Card
            title="BOTTLENECK MACHINES"
            actionLabel={bottlenecks.length > 1 ? (expand.bottleneck ? "Show Less" : "View All") : undefined}
            onAction={() => toggle("bottleneck")}
          >
            <Bottleneck rows={visibleBottlenecks} top={topBottleneck} queueLen={queueLen} />
          </Card>
        </div>
      </div>

      {/* BOTTOM 4-PANEL ROW */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card
          title="DUE TODAY"
          actionLabel={DUE.length > 4 ? (expand.due ? "Show Less" : "View All") : undefined}
          onAction={() => toggle("due")}
        >
          <DueToday rows={visibleDue} />
        </Card>
        <Card
          title="NEXT RELEASES"
          actionLabel={RELEASES.length > 4 ? (expand.releases ? "Show Less" : "View All") : undefined}
          onAction={() => toggle("releases")}
        >
          <Releases rows={visibleReleases} />
        </Card>
        <Card
          title="ALERTS"
          actionLabel={alerts.length > 4 ? (expand.alerts ? "Show Less" : "View All") : undefined}
          onAction={() => toggle("alerts")}
        >
          <Alerts rows={visibleAlerts} />
        </Card>
        <Card title="ORDER SUMMARY">
          <OrderSummary data={summary} total={counts.total} />
        </Card>
      </div>

      {/* FOOTER — working refresh controls */}
      <div className="flex items-center justify-between text-xs text-slate-500 border-t border-slate-700 pt-3 flex-wrap gap-2">
        <span>Last Updated: {lastUpdated}</span>
        <div className="flex items-center gap-4">
          <span>Data Source: MES System</span>
          <button
            onClick={() => {
              const i = REFRESH_OPTIONS.indexOf(refreshMs)
              setRefreshMs(REFRESH_OPTIONS[(i + 1) % REFRESH_OPTIONS.length])
            }}
            className="hover:text-slate-300"
            title="Click to change interval"
          >
            Auto Refresh: {refreshMs / 1000} sec
          </button>
          <button
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1.5 hover:text-slate-300"
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? "Paused" : "Live"}
            <span
              className={`w-2 h-2 rounded-full ${paused ? "bg-slate-500" : "bg-green-400 animate-pulse"}`}
            />
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   GENERIC CARD
============================================================ */

function Card({
  title,
  actionLabel,
  onAction,
  children,
}: {
  title: string
  actionLabel?: string
  onAction?: () => void
  children: ReactNode
}) {
  return (
    <section className="bg-slate-800 border border-slate-700 rounded-lg p-4 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold tracking-wide text-slate-200">{title}</h3>
        {actionLabel && (
          <button
            onClick={onAction}
            className="text-xs text-slate-400 hover:text-green-400 flex items-center gap-1"
          >
            {actionLabel}
            <Icon name="chevron" className="w-3 h-3" />
          </button>
        )}
      </div>
      {children}
    </section>
  )
}

/* ============================================================
   KPI CARD
============================================================ */

function KpiCard({
  icon,
  label,
  value,
  color,
  highlight,
}: {
  icon: string
  label: string
  value: string
  color: string
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 flex items-center gap-3 ${
        highlight ? "bg-slate-700/40 border-green-500/40" : "bg-slate-800 border-slate-700"
      }`}
    >
      <div className={`w-9 h-9 rounded-lg bg-slate-900 flex items-center justify-center shrink-0 ${color}`}>
        <Icon name={icon} className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <div className="text-lg font-bold text-white leading-none tabular-nums">{value}</div>
        <div className="text-[10px] tracking-wide text-slate-400 mt-1 leading-tight">{label}</div>
      </div>
    </div>
  )
}

/* ============================================================
   ORDER STATUS TABLE
============================================================ */

function OrdersTable({ orders }: { orders: Order[] }) {
  const cols = "grid grid-cols-[2.6rem_minmax(0,1fr)_5.6rem_3.4rem] gap-2 items-center"
  return (
    <div className="text-xs">
      <div className={`${cols} text-[10px] text-slate-500 pb-2 border-b border-slate-700`}>
        <span>Order ID</span>
        <span>Progress</span>
        <span>Due Date</span>
        <span>Status</span>
      </div>
      {orders.length === 0 ? (
        <div className="text-slate-500 py-3 text-center">No matching orders</div>
      ) : (
        orders.map((o) => (
          <div key={o.id} className={`${cols} py-1.5 border-b border-slate-800/80`}>
            <span className="text-slate-200 font-medium">{o.id}</span>
            <div className="relative h-3.5 rounded bg-slate-900 overflow-hidden">
              <div
                className="h-full transition-all duration-500"
                style={{ width: `${o.progress}%`, background: ORDER_STATUS_COLOR[o.status] + "cc" }}
              />
              <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white font-medium">
                {Math.round(o.progress)}%
              </span>
            </div>
            <span className="text-slate-400 text-[10px] whitespace-nowrap">{o.due}</span>
            <span className="font-medium" style={{ color: ORDER_STATUS_COLOR[o.status] }}>
              {o.status}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

/* ============================================================
   GANTT
============================================================ */

function Gantt({
  nowHours,
  nowLabel,
  selected,
  onSelect,
}: {
  nowHours: number
  nowLabel: string
  selected: string | null
  onSelect: (key: string) => void
}) {
  const GUTTER = 40
  const ROW_H = 42

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const hoverLineRef = useRef<HTMLDivElement | null>(null)
  const hoverPillRef = useRef<HTMLDivElement | null>(null)

  // Measure the viewport so exactly VISIBLE_HOURS fit; everything else scrolls.
  const [viewW, setViewW] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setViewW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pxPerHour = viewW > 0 ? Math.max(48, (viewW - GUTTER) / VISIBLE_HOURS) : PX_PER_HOUR
  const xOf = (h: number) => (h - DAY_START) * pxPerHour
  const trackWidth = (DAY_END - DAY_START) * pxPerHour
  const innerWidth = GUTTER + trackWidth

  // The hover scrubber is updated imperatively (no React state) so dragging the
  // cursor never re-renders the dashboard — keeps it perfectly smooth.
  const moveHover = (clientX: number) => {
    const scroll = scrollRef.current
    const rows = rowsRef.current
    const line = hoverLineRef.current
    const pill = hoverPillRef.current
    if (!scroll || !rows || !line || !pill) return
    const sRect = scroll.getBoundingClientRect()
    if (clientX < sRect.left + GUTTER) {
      line.style.opacity = "0"
      pill.style.opacity = "0"
      return
    }
    const rRect = rows.getBoundingClientRect()
    const x = clamp(clientX - rRect.left - GUTTER, 0, trackWidth)
    line.style.left = `${x}px`
    line.style.opacity = "1"
    pill.style.left = `${x}px`
    pill.style.opacity = "1"
    pill.textContent = hoursToLabel(DAY_START + x / pxPerHour)
  }
  const hideHover = () => {
    if (hoverLineRef.current) hoverLineRef.current.style.opacity = "0"
    if (hoverPillRef.current) hoverPillRef.current.style.opacity = "0"
  }

  return (
    <div>
      {/* horizontal scroll area — the M1..M6 gutter stays pinned, the timeline scrolls */}
      <div className="overflow-x-auto" ref={scrollRef}>
        <div style={{ width: innerWidth }}>
          {/* time axis */}
          <div className="flex h-4">
            <div
              style={{ width: GUTTER }}
              className="sticky left-0 z-30 bg-slate-800 text-[11px] text-slate-400"
            >
              Time
            </div>
            <div className="relative" style={{ width: trackWidth }}>
              {HOURS.map((h, i) => {
                const anchor =
                  i === 0
                    ? "translate-x-0"
                    : i === HOURS.length - 1
                    ? "-translate-x-full"
                    : "-translate-x-1/2"
                return (
                  <span
                    key={h}
                    className={`absolute ${anchor} text-[11px] text-slate-400 whitespace-nowrap`}
                    style={{ left: xOf(h) }}
                  >
                    {fmtHour(h)}
                  </span>
                )
              })}
              <div
                ref={hoverPillRef}
                className="absolute -top-0.5 -translate-x-1/2 px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px] font-semibold tabular-nums whitespace-nowrap z-20 pointer-events-none opacity-0"
                style={{ left: 0 }}
              />
            </div>
          </div>

          {/* rows + overlays */}
          <div
            className="relative mt-1"
            style={{ width: innerWidth }}
            ref={rowsRef}
            onMouseMove={(e) => moveHover(e.clientX)}
            onMouseLeave={hideHover}
          >
            {/* gridlines */}
            <div
              className="absolute inset-y-0 pointer-events-none"
              style={{ left: GUTTER, width: trackWidth }}
            >
              {HOURS.map((h) => (
                <div
                  key={h}
                  className="absolute inset-y-0 w-px bg-slate-700/40"
                  style={{ left: xOf(h) }}
                />
              ))}
            </div>

            {/* machine rows */}
            {MACHINES.map((m) => (
              <div key={m} className="flex items-center" style={{ height: ROW_H }}>
                <div
                  style={{ width: GUTTER }}
                  className="sticky left-0 z-30 bg-slate-800 h-full flex items-center text-xs font-semibold text-slate-300"
                >
                  {m}
                </div>
                <div className="relative h-full" style={{ width: trackWidth }}>
                  {TASKS.filter((t) => t.machine === m).map((t, i) => {
                    const key = `${m}-${i}`
                    const left = xOf(t.start)
                    const width = (t.end - t.start) * PX_PER_HOUR
                    const bg = t.color ?? STATUS_COLOR[t.status]
                    const isSel = selected === key
                    return (
                      <button
                        key={key}
                        title={`${t.label} · ${fmtHour(Math.floor(t.start))}–${fmtHour(Math.floor(t.end))}`}
                        onClick={() => onSelect(key)}
                        className="absolute top-1/2 -translate-y-1/2 rounded flex items-center justify-center text-[11px] font-semibold overflow-hidden whitespace-nowrap px-1 transition-shadow"
                        style={{
                          left,
                          width,
                          height: ROW_H - 12,
                          background: bg,
                          color: "#0b1220",
                          boxShadow: isSel ? "0 0 0 2px #fff inset" : "none",
                          opacity: selected && !isSel ? 0.55 : 1,
                        }}
                      >
                        {t.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}

            {/* hover guide — calendar-style scrubber (updated imperatively for smoothness) */}
            <div
              className="absolute inset-y-0 pointer-events-none z-10"
              style={{ left: GUTTER, width: trackWidth }}
            >
              <div
                ref={hoverLineRef}
                className="absolute inset-y-0 border-l border-dashed border-red-400/80 opacity-0"
                style={{ left: 0 }}
              />
            </div>
            {/* "now" label */}
            <div className="flex" style={{ height: 18 }}>
              <div style={{ width: GUTTER }} className="sticky left-0 z-30 bg-slate-800" />
              <div className="relative" style={{ width: trackWidth }}>

              </div>
            </div>
          </div>
        </div>
      </div>

      {/* legend (stays put, outside the scroll area) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-slate-700">
        {LEGEND.map((l) => (
          <span key={l.status} className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="w-3 h-3 rounded-sm" style={{ background: STATUS_COLOR[l.status] }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ============================================================
   MACHINE UTILIZATION
============================================================ */

function Utilization({ rows }: { rows: Util[] }) {
  return (
    <div className="flex flex-col gap-3">
      {rows.map((u) => {
        const red = u.pct >= BOTTLENECK_THRESHOLD
        return (
          <div key={u.m} className="flex items-center gap-3">
            <span className="text-xs font-semibold text-slate-300 w-7 shrink-0">{u.m}</span>
            <div className="flex-1 h-2.5 rounded-full bg-slate-900 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${u.pct}%`, background: red ? "#ef4444" : "#22c55e" }}
              />
            </div>
            <div className="w-14 text-right shrink-0">
              <span className={`text-xs font-semibold tabular-nums ${red ? "text-red-400" : "text-slate-200"}`}>
                {u.pct}%
              </span>
              {red && <div className="text-[9px] text-red-500 font-semibold leading-none">BOTTLENECK</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ============================================================
   BOTTLENECK MACHINES
============================================================ */

function Bottleneck({ rows, top, queueLen }: { rows: Util[]; top: Util; queueLen: number }) {
  const active = top.pct >= BOTTLENECK_THRESHOLD
  return (
    <div className="flex flex-col items-center gap-3">
      {rows.map((r) => {
        const isActive = r.pct >= BOTTLENECK_THRESHOLD
        return (
          <div
            key={r.m}
            className={`w-full rounded-md py-3 flex items-center justify-center gap-4 border ${
              isActive
                ? "bg-red-950/60 border-red-800/60 text-red-300"
                : "bg-slate-900 border-slate-700 text-slate-300"
            }`}
          >
            <span className="text-lg font-bold">{r.m}</span>
            <span className="text-lg font-bold tabular-nums">{r.pct}%</span>
          </div>
        )
      })}
      <div className="flex items-center gap-1.5 text-xs text-slate-400">
        <Icon name="warn" className={`w-3.5 h-3.5 ${active ? "text-amber-400" : "text-slate-500"}`} />
        Queue Length : {queueLen} Jobs
      </div>
    </div>
  )
}

/* ============================================================
   DUE TODAY
============================================================ */

function DueToday({ rows }: { rows: { id: string; time: string }[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((d, i) => (
        <div key={`${d.id}-${i}`} className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 text-slate-200">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            {d.id}
          </span>
          <span className="text-slate-400">{d.time}</span>
        </div>
      ))}
    </div>
  )
}

/* ============================================================
   NEXT RELEASES
============================================================ */

function Releases({ rows }: { rows: { time: string; part: string; to: string }[] }) {
  return (
    <div className="flex flex-col gap-2.5 text-sm">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-slate-400 w-16 shrink-0">{r.time}</span>
          <span className="text-slate-200 flex-1 truncate">{r.part}</span>
          <Icon name="arrow" className="w-4 h-4 text-slate-500 shrink-0" />
          <span className="text-green-400 font-medium shrink-0">{r.to}</span>
        </div>
      ))}
    </div>
  )
}

/* ============================================================
   ALERTS
============================================================ */

const ALERT_DOT: Record<"red" | "amber" | "green", string> = {
  red: "bg-red-500",
  amber: "bg-amber-400",
  green: "bg-green-400",
}

function Alerts({ rows }: { rows: { level: "red" | "amber" | "green"; text: string }[] }) {
  return (
    <div className="flex flex-col gap-2.5 text-sm">
      {rows.map((a, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${ALERT_DOT[a.level]}`} />
          <span className="text-slate-200">{a.text}</span>
        </div>
      ))}
    </div>
  )
}

/* ============================================================
   ORDER SUMMARY (donut)
============================================================ */

function OrderSummary({
  data,
  total,
}: {
  data: { name: string; value: number; color: string }[]
  total: number
}) {
  const slices = data.filter((d) => d.value > 0)
  return (
    <div className="flex items-center gap-4">
      <div className="relative w-32 h-32 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              innerRadius={42}
              outerRadius={60}
              paddingAngle={2}
              stroke="none"
              startAngle={90}
              endAngle={-270}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={s.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-2xl font-bold text-white leading-none tabular-nums">{total}</div>
          <div className="text-[11px] text-slate-400">Orders</div>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-2 text-sm">
        {data.map((s) => (
          <div key={s.name} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-slate-300">
              <span className="w-3 h-3 rounded-sm" style={{ background: s.color }} />
              {s.name}
            </span>
            <span className="text-slate-200 tabular-nums">{s.value}</span>
            <span className="text-slate-400 w-10 text-right tabular-nums">
              {total ? Math.round((s.value / total) * 100) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ============================================================
   INLINE ICONS
============================================================ */

function Icon({ name, className = "w-5 h-5" }: { name: string; className?: string }) {
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const

  switch (name) {
    case "factory":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M3 21V9l6 4V9l6 4V6l6 3v12z" />
          <path d="M3 21h18" />
        </svg>
      )
    case "bell":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M6 9a6 6 0 0 1 12 0c0 4 2 5 2 6H4c0-1 2-2 2-6" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      )
    case "chevron":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      )
    case "box":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M21 8l-9-5-9 5 9 5 9-5z" />
          <path d="M3 8v8l9 5 9-5V8" />
          <path d="M12 13v8" />
        </svg>
      )
    case "play":
      return (
        <svg viewBox="0 0 24 24" className={className}>
          <path d="M8 5v14l11-7z" fill="currentColor" />
        </svg>
      )
    case "hourglass":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M6 3h12M6 21h12" />
          <path d="M7 3c0 4 4 5 5 6 1 1 5 2 5 6M17 3c0 4-4 5-5 6-1 1-5 2-5 6" />
        </svg>
      )
    case "check":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 12.5l2.5 2.5 4.5-5" />
        </svg>
      )
    case "gauge":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M4 15a8 8 0 0 1 16 0" />
          <path d="M12 15l4-3" />
        </svg>
      )
    case "layers":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M12 3l9 5-9 5-9-5z" />
          <path d="M3 13l9 5 9-5" />
        </svg>
      )
    case "bars":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M4 20V11M9.3 20V5M14.6 20v-6M20 20H3" />
        </svg>
      )
    case "target":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
      )
    case "warn":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M12 4l9 16H3z" />
          <path d="M12 10v4M12 17v.5" />
        </svg>
      )
    case "arrow":
      return (
        <svg viewBox="0 0 24 24" className={className} {...p}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      )
    default:
      return null
  }
}
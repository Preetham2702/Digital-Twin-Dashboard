import React, { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

/* ── useWindowSize hook ─────────────────────────────────────── */
function useWindowSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const handler = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return size;
}

/* ══════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════ */
export default function PocketNC({ onConnectionChange }: any) {
  const [status, setStatus] = useState<any>({});
  const { w, h } = useWindowSize();

  useEffect(() => {
    let ws = new WebSocket("ws://localhost:8000/ws/printer");
    onConnectionChange?.(null);
    ws.onopen = () => onConnectionChange?.(true);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data?.raw_status) setStatus(data.raw_status);
    };
    ws.onclose = () => onConnectionChange?.(false);
    return () => ws.close();
  }, []);

  const position = status?.toolhead?.position || [0, 0, 0];
  const spindle  = status?.spindle_speed || 0;
  const feed     = status?.current_vel ? status.current_vel * 60 : 0;

  // ╔══════════════════════════════════════════════════════╗
  // ║          LAYOUT TUNING — edit these values          ║
  // ╠══════════════════════════════════════════════════════╣
  const LEFT_PANEL_PCT   = 0.3;   // ← left panel width %
  const LEFT_PANEL_MIN   = 260;    // ← min px
  const LEFT_PANEL_MAX   = 480;    // ← max px

  const GAUGE_PCT        = 0.25;   // ← gauge diameter % of height
  const GAUGE_MIN        = 140;    // ← min px
  const GAUGE_MAX        = 220;    // ← max px

  const AXIS_BOX_W_PCT   = 0.1;  // ← axis box width % of right panel
  const AXIS_BOX_W_MIN   = 90;     // ← min px
  const AXIS_BOX_W_MAX   = 140;    // ← max px
  const AXIS_BOX_H_RATIO = 0.38;   // ← axis box height relative to gauge
  const AXIS_BOX_GAP     = 18;     // ← gap between axis boxes (px)

  const GCODE_PCT        = 0.10;   // ← gcode panel height % of screen
  const GCODE_MIN        = 80;     // ← min px
  const GCODE_MAX        = 150;    // ← max px

  const STREAM_PCT       = 0.50;   // ← streaming box height % of screen
  const SLIDER_LABEL_PCT = 0.09;   // ← slider label width % of right panel
  const SLIDER_LABEL_MIN = 80;     // ← min px
  const SLIDER_LABEL_MAX = 120;    // ← max px

  const FONT_PCT         = 0.009;  // ← base font size % of width
  const FONT_MIN         = 10;     // ← min px
  const FONT_MAX         = 14;     // ← max px

  const PAD_PCT          = 0.015;  // ← outer padding % of height
  const GAP_PCT          = 0.012;  // ← row gap % of height
  // ╚══════════════════════════════════════════════════════╝

  // ── Computed values ────────────────────────────────────
  const leftW        = Math.round(Math.min(Math.max(w * LEFT_PANEL_PCT,  LEFT_PANEL_MIN),  LEFT_PANEL_MAX));
  const rightW       = w - leftW;
  const gaugeSize    = Math.round(Math.min(Math.max(h * GAUGE_PCT,       GAUGE_MIN),       GAUGE_MAX));
  const axisH        = Math.round(gaugeSize * AXIS_BOX_H_RATIO);
  const axisW        = Math.round(Math.min(Math.max(rightW * AXIS_BOX_W_PCT, AXIS_BOX_W_MIN), AXIS_BOX_W_MAX));
  const gcodeH       = Math.round(Math.min(Math.max(h * GCODE_PCT,       GCODE_MIN),       GCODE_MAX));
  const sliderLabelW = Math.round(Math.min(Math.max(rightW * SLIDER_LABEL_PCT, SLIDER_LABEL_MIN), SLIDER_LABEL_MAX));
  const fontSize     = Math.round(Math.min(Math.max(w * FONT_PCT,        FONT_MIN),        FONT_MAX));
  const pad          = Math.round(h * PAD_PCT);
  const gap          = Math.round(h * GAP_PCT);
  const streamH      = Math.round(h * STREAM_PCT);

  return (
    <div
      className="overflow-hidden flex text-gray-200"
      style={{ background: "#1e293b", width: "100vw", height: "95vh", fontSize }}
    >
      {/* ═══════════ LEFT PANEL ═══════════ */}
      <div
        className="shrink-0 flex flex-col border-r border-slate-600"
        style={{ width: leftW, padding: Math.round(leftW * 0.07), gap: Math.round(leftW * 0.06), background: "#1e293b" }}
      >
        <button
          className="w-full bg-red-500 hover:bg-red-600 text-white font-bold rounded tracking-widest"
          style={{ padding: `${Math.round(gaugeSize * 0.04)}px 0`, fontSize: fontSize * 0.9 }}
        >
          E-STOP
        </button>

        <div>
          <p className="text-gray-400" style={{ fontSize: fontSize * 1.3, marginBottom: 4 }}>Upload File</p>
          <input
            type="file"
            className="w-full rounded border border-slate-700 text-gray-300"
            style={{
                background: "#0f172a",
                fontSize: fontSize * 1.0,
                padding: `${Math.round(gaugeSize * 0.08)}px ${Math.round(gaugeSize * 0.06)}px`,
                height: Math.round(gaugeSize * 0.25)
              }}
          />
        </div>

        <div>
          <p className="text-gray-400" style={{ fontSize: fontSize * 1.3, marginBottom: 4 }}>Existing File</p>
          <div
            className="w-full border border-slate-600 rounded flex items-center text-gray-500"
            style={{
                background: "#0f172a",
                fontSize: fontSize * 1.0,
                padding: `${Math.round(gaugeSize * 0.08)}px ${Math.round(gaugeSize * 0.06)}px`,
                height: Math.round(gaugeSize * 0.25)
              }}
          >
            No file selected
          </div>
        </div>

        <div className="flex gap-2">
          {[
            { icon: "▶", cls: "bg-green-600 hover:bg-green-600" },
            { icon: "⏸", cls: "bg-yellow-500 hover:bg-yellow-500" },
            { icon: "■", cls: "bg-red-600 hover:bg-red-600" },
          ].map(({ icon, cls }) => (
            <button key={icon} className={`flex-1 rounded ${cls}`}
              style={{ padding: `${Math.round(gaugeSize * 0.045)}px 0`, fontSize: fontSize * 1.15 }}>
              {icon}
            </button>
          ))}
        </div>

        {/* Live Streaming — fixed height */}
        <div
          className="rounded border border-slate-600 flex items-center justify-center"
          style={{ background: "#0f172a", height: streamH, flexShrink: 0 }}
        >
          <span className="text-gray-600" style={{ fontSize: fontSize * 0.82 }}>Live Streaming</span>
        </div>
      </div>

      {/* ═══════════ RIGHT PANEL ═══════════ */}
      <div
        className="flex-1 min-w-0 flex flex-col overflow-hidden"
        style={{ padding: pad, gap }}
      >
        {/* ROW 1 — Gauges + Axis (all horizontal) */}
        <div className="flex items-center shrink-0" style={{ gap: 48}}>

          <GaugeBlock label="Spindle" value={spindle} max={24000} unit="RPM"
            rings={["Power","Load","Temp"]} size={gaugeSize} fontSize={fontSize} />

          <GaugeBlock label="Feed" value={feed} max={2000} unit="In/min"
            rings={["Power","Chip Load","Surface Speed"]} size={gaugeSize} fontSize={fontSize} />

          {/* Axis boxes — horizontal row with bigger size and clear gaps */}
          <div className="flex items-center" style={{ gap: AXIS_BOX_GAP, marginLeft: Math.round(20) }}>
            {[
              ["X", position[0]],
              ["Y", position[1]],
              ["Z", position[2]],
              ["A", 0],
              ["B", 0],
            ].map(([lbl, val]) => (
              <AxisBox key={lbl as string} label={lbl as string} value={val as number}
                w={axisW} h={axisH} fontSize={fontSize} />
            ))}
          </div>
        </div>

        {/* ROW 2 — Sliders: two symmetric halves side by side */}
        <div className="flex shrink-0" style={{ gap: Math.round(rightW * 0.04) }}>
          {/* Left column */}
          <div className="flex-1 flex flex-col" style={{ gap: Math.round(h * 0.012) }}>
            <Slider label="Max Velocity" labelW={sliderLabelW} fontSize={20} />
            <Slider label="Feed Rate"    labelW={sliderLabelW} fontSize={20} />
          </div>
          {/* Right column */}
          <div className="flex-1 flex flex-col" style={{ gap: Math.round(h * 0.012) }}>
            <Slider label="Max Rapid"    labelW={sliderLabelW} fontSize={20} />
            <div className="flex items-center" style={{ gap: 8 }}>
              <div className="flex-1">
                <Slider label="Spindle Rate" labelW={sliderLabelW} fontSize={20} />
              </div>
            </div>
          </div>
        </div>

        {/* ROW 3 — Charts */}
        <div className="flex-1 min-h-0 grid grid-rows-2" style={{ gap, height:"150px" }}>
          {["Any Charts", "Any Charts"].map((lbl, i) => (
            <div key={i} className="rounded border border-slate-700 flex items-center justify-center text-gray-600"
              style={{ background: "#0f172a", fontSize }}>
              {lbl}
            </div>
          ))}
        </div>

        {/* ROW 4 — GCode */}
        <div
          className="rounded border border-slate-700 overflow-auto shrink-0"
          style={{ background: "#0f172a", height: gcodeH, padding: "8px 12px" }}
        >
          <p className="text-gray-500 uppercase tracking-widest" style={{ fontSize: fontSize * 0.75, marginBottom: 4 }}>G-Code</p>
          <div className="font-mono text-green-400" style={{ fontSize: fontSize * 0.82, lineHeight: 1.6 }} />
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   GAUGE BLOCK
══════════════════════════════════════════════════════════════ */
function GaugeBlock({ label, value, max, unit, rings, size, fontSize }: any) {
    return (
      <div className="flex flex-col items-center" style={{ gap: 2 }}>
        <p className="text-gray-300 font-bold uppercase tracking-widest"
           style={{ fontSize: fontSize * 0.85, letterSpacing: "0.15em" }}>{label}</p>
        <SegmentedRingGauge value={value} max={max} unit={unit} rings={rings} size={size} fontSize={fontSize} />
      </div>
    );
  }
   
  function SegmentedRingGauge({ value, max, unit, rings, size, fontSize }: any) {
    const cx = size / 2;
    const cy = size / 2;
    const R  = size * 0.42;          // arc radius
    const segW = Math.max(size * 0.055, 6);  // segment tick width
    const gap  = 3;                   // degrees gap between segments
   
    const toRad = (d: number) => (d * Math.PI) / 180;
   
    // Three arcs: Power (left), Load/ChipLoad (right), Temp/Surface (bottom)
    // Each arc: startDeg, endDeg (in SVG angle space, 0=right, 90=bottom)
    const arcDefs = [
      { startDeg: 200, endDeg: 310, label: rings[0], sublabel: "" },  // Power — left side
      { startDeg: 350, endDeg: 460, label: rings[1], sublabel: "" },  // Load  — right side (460=100)
      { startDeg: 130, endDeg: 200, label: rings[2], sublabel: "" },  // Temp  — bottom
    ] as const;
   
    // Remap: arc fills based on value fraction
    const frac = Math.min(value / max, 1);
   
    // Segment colors — green → yellow → orange gradient per segment index
    function segColor(arcIdx: number, segIdx: number, total: number) {
      const t = segIdx / total;
      if (arcIdx === 0) {
        // Power: green to yellow
        if (t < 0.5) return "#4ade80";
        if (t < 0.8) return "#a3e635";
        return "#facc15";
      }
      if (arcIdx === 1) {
        // Load/ChipLoad: green to yellow-orange
        if (t < 0.5) return "#4ade80";
        if (t < 0.75) return "#a3e635";
        return "#facc15";
      }
      // Temp/Surface: teal to green
      if (t < 0.4) return "#2dd4bf";
      if (t < 0.8) return "#4ade80";
      return "#a3e635";
    }
   
    // Build tick segments for one arc
    function buildSegments(startDeg: number, endDeg: number, arcIdx: number) {
      const spanDeg = endDeg - startDeg;
      const nSegs   = Math.round(spanDeg / 8); // ~one tick per 8°
      const ticks   = [];
      for (let i = 0; i < nSegs; i++) {
        const t    = i / (nSegs - 1);
        const aDeg = startDeg + (spanDeg * i) / (nSegs - 1);
        const aRad = toRad(aDeg);
        const r1   = R - segW / 2;
        const r2   = R + segW / 2;
        const cos  = Math.cos(aRad);
        const sin  = Math.sin(aRad);
        // filled based on frac; all three arcs fill together
        const filled = frac > t;
        const color  = filled ? segColor(arcIdx, i, nSegs) : "#1e3a52";
        ticks.push(
          <line key={i}
            x1={cx + r1 * cos} y1={cy + r1 * sin}
            x2={cx + r2 * cos} y2={cy + r2 * sin}
            stroke={color} strokeWidth={Math.max(size * 0.018, 2.5)}
            strokeLinecap="round"
          />
        );
      }
      return ticks;
    }
   
    // Curved text along arc path
    function curvedLabel(startDeg: number, endDeg: number, text: string, idx: number) {
      const midDeg = (startDeg + endDeg) / 2;
      const labelR = R - size * 0.085;
      const pathR  = labelR;
      // create arc path for textPath
      const sDeg = midDeg - 30;
      const eDeg = midDeg + 30;
      const x1 = cx + pathR * Math.cos(toRad(sDeg));
      const y1 = cy + pathR * Math.sin(toRad(sDeg));
      const x2 = cx + pathR * Math.cos(toRad(eDeg));
      const y2 = cy + pathR * Math.sin(toRad(eDeg));
      const id = `arc-label-${idx}`;
      const fs = Math.max(size * 0.042, 7);
      return (
        <g key={idx}>
          <defs>
            <path id={id} d={`M ${x1} ${y1} A ${pathR} ${pathR} 0 0 1 ${x2} ${y2}`} />
          </defs>
          <text fill="#94a3b8" fontSize={fs} fontWeight="600" letterSpacing="0.08em"
                style={{ textTransform: "uppercase" }}>
            <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
              {text}
            </textPath>
          </text>
        </g>
      );
    }
   
    const valFS  = Math.max(size * 0.18, 20);
    const unitFS = Math.max(size * 0.07, 9);
   
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Tick segments for each arc */}
        {arcDefs.map((arc, i) => buildSegments(arc.startDeg, arc.endDeg, i))}
   
        {/* Curved labels */}
        {arcDefs.map((arc, i) => curvedLabel(arc.startDeg, arc.endDeg, arc.label, i))}
   
        {/* Center value */}
        <text x={cx} y={cy + valFS * 0.35}
          textAnchor="middle" fill="white" fontSize={valFS} fontWeight="bold"
          fontFamily="monospace">
          {value.toFixed(0)}
        </text>
        <text x={cx} y={cy + valFS * 0.35 + unitFS * 1.5}
          textAnchor="middle" fill="#64748b" fontSize={unitFS}
          fontWeight="600" letterSpacing="0.1em">
          {unit.toUpperCase()}
        </text>
      </svg>
    );
  }
   

/* ══════════════════════════════════════════════════════════════
   AXIS BOX
══════════════════════════════════════════════════════════════ */
function AxisBox({ label, value, h, fontSize }: any) {
  return (
    <div
      className="rounded-lg flex flex-col items-center justify-center border border-slate-500"
      style={{ background: "#0f172a", width: 100, height: 80, gap: 4 }}
    >
      <span className="text-gray-400 font-semibold uppercase tracking-wider"
        style={{ fontSize: fontSize * 0.82 }}>{label}</span>
      <span className="text-green-400 font-bold "
        style={{ fontSize: fontSize * 1.1 }}>
        {typeof value === "number" ? value.toFixed(3) : value}
      </span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   SLIDER
══════════════════════════════════════════════════════════════ */
function Slider({ label, labelW, fontSize }: any) {
  const [val, setVal] = useState(50);
  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      <p className="text-gray-400 shrink-0" style={{ fontSize: fontSize * 0.82, width: labelW }}>{label}</p>
      <input type="range" min={0} max={100} value={val}
        onChange={(e) => setVal(Number(e.target.value))}
        className="flex-1 accent-green-500" />
      <span className="text-gray-400" style={{ fontSize: fontSize * 0.82, width: 10, textAlign: "right" }}>
        {Math.round(val / 10)}
      </span>
    </div>
  );
}
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
  const [files, setFiles] = useState<string[]>([]);
  const [runLine, setRunLine] = useState(0);
  const [currentLine, setCurrentLine] = useState(0)
  const [currentFile, setCurrentFile] = useState("")
  const [gcodeLines, setGcodeLines] = useState<string[]>([])
  const [rpmData, setRpmData] = useState<{ time: number; rpm: number }[]>([]);
  const [feedData, setFeedData] = useState<{ time: number; feed: number }[]>([]);

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:8000/ws/pocketnc");
  
    // 🔥 fetch files
    fetch("http://localhost:8000/pocketnc/files")
      .then(res => res.json())
      .then(d => d.files && setFiles(d.files))
      .catch(console.log);
  
    onConnectionChange?.(null);
  
    // 🔥 helper to fetch G-code
    const fetchGcode = (file: string) => {
      if (!file) return;
      fetch(`http://localhost:8000/pocketnc/file-content?file=${file}`)
        .then(res => res.json())
        .then(d => d.lines && setGcodeLines(d.lines))
        .catch(console.log);
    };
  
    ws.onopen = () => {
      console.log("✅ PocketNC WS Connected");
    };
  
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      console.log("RPM:", d?.raw_status?.spindle_speed, d?.rpm);
  
      onConnectionChange?.(d?.connected ?? false);
  
      // 🔥 HANDLE STATUS
      if (d?.raw_status) {
        const s = d.raw_status;
  
        setStatus(s);
  
        const line = s?.current_line || 0;
        const file = s?.current_file || "";
  
        setCurrentLine(line);
  
        setCurrentFile(prev => {
          if (prev !== file) fetchGcode(file); // load file once
          return file;
        });
  
        // 🔥 ADD RPM DATA (IMPORTANT)
        const rpm = s?.spindle_speed ?? d?.rpm ?? 0;
  
        setRpmData(prev => {
          const updated = [
            ...prev,
            { time: Date.now(), rpm }
          ];
  
          return updated.slice(-50); // keep last 50 points
        });
        
        const feed = s?.current_vel ?? d?.feed ?? 0;

        setFeedData(prev => {
          const updated = [
            ...prev,
            { time: Date.now(), feed }
          ];
          return updated.slice(-50);
        });
      }
    };
  
    ws.onclose = () => {
      console.log("❌ WS Closed");
      onConnectionChange?.(false);
    };
  
    ws.onerror = (err) => {
      console.log("❌ WS Error:", err);
      onConnectionChange?.(false);
    };
  
    return () => ws.close();
  }, []);
  
  const position = [
    status?.x ?? 0,
    status?.y ?? 0,
    status?.z ?? 0,
    status?.a ?? 0,
    status?.b ?? 0,
  ];
  const spindle  = status?.spindle_speed || 0;
  const feed = status?.feed_rate || 0;
  const [activeGcodes, setActiveGcodes] = useState("")

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
  const gcodeHeight = 200  // 👉 change this (300, 500, 700, etc.)
  const gcodePadding = "10px 12px"
  const gcodeFontScale = 0.82

  const start = () =>
    fetch("http://localhost:8000/pocketnc/start", { method: "POST" });
  
  const pause = () =>
    fetch("http://localhost:8000/pocketnc/pause", { method: "POST" });
  
  const stop = () =>
    fetch("http://localhost:8000/pocketnc/stop", { method: "POST" });

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
          onClick={() => fetch("http://localhost:8000/pocketnc/estop", { method: "POST" })}
          className="w-full bg-red-500 hover:bg-red-600 text-white font-bold rounded tracking-widest"
        >
          E-STOP
        </button>

        <div>
          <p className="text-gray-400" style={{ fontSize: fontSize * 1.3, marginBottom: 4 }}>Upload File</p>
          <input
            type="file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
          
              // 🔥 send filename to backend (load step)
              await fetch(`http://localhost:8000/pocketnc/load?file=${file.name}`, {
                method: "POST",
              });
            }}
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
          <div className="w-full h-full overflow-auto">
            {files.length === 0 ? (
              <span>No files</span>
            ) : (
              files.map((file) => (
                <div
                  key={file}
                  className="cursor-pointer hover:text-green-400"
                  onClick={async () => {
                    await fetch(`http://localhost:8000/pocketnc/load?file=${file}`, {
                      method: "POST",
                    });

                    fetch("http://localhost:8000/pocketnc/files")
                      .then(res => res.json())
                      .then(d => d.files && setFiles(d.files));
                  }}
                >
                  {file}
                </div>
              ))
            )}
          </div>
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={start} className="flex-1 bg-green-600 rounded">▶</button>
          <button onClick={pause} className="flex-1 bg-yellow-500 rounded">⏸</button>
          <button onClick={stop}  className="flex-1 bg-red-600 rounded">■</button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-400">Run From:</span>

          <input
            type="number"
            value={runLine}
            onChange={(e) => {
              const value = Number(e.target.value);
              setRunLine(value);

              fetch(`http://localhost:8000/pocketnc/set-line?line=${value}`, {
                method: "POST",
              });
            }}
            className="w-16 bg-slate-800 text-white border border-slate-600 rounded px-2"
          />
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

          {/* Axis + Active GCodes */}
          <div className="flex flex-col items-center" style={{ gap: 12 }}>

            {/* 🔥 AXIS ROW (UNCHANGED) */}
            <div
              className="flex items-center"
              style={{ gap: AXIS_BOX_GAP, marginLeft: 20 }}
            >
              {[
                ["X", position[0]],
                ["Y", position[1]],
                ["Z", position[2]],
                ["A", position[3] ?? 0],
                ["B", position[4] ?? 0],
              ].map(([lbl, val]) => (
                <AxisBox
                  key={lbl as string}
                  label={lbl as string}
                  value={val as number}
                  w={axisW}
                  h={axisH}
                  fontSize={fontSize}
                />
              ))}
            </div>
            {/* HOME ALL BUTTON */}
            <button
              onClick={() =>
                fetch("http://localhost:8000/pocketnc/home-all", {
                  method: "POST",
                })
              }
              className="bg-slate-700 hover:bg-green-600 text-white rounded"
              style={{
                padding: "8px 14px",
                fontSize: fontSize * 1,
                display: "flex",
                alignItems: "center",
                gap: 6
              }}
            >
              ⌂ Home All
            </button>

            {/* ACTIVE G-CODES BOX */}
            <div
              className="rounded border border-slate-700 text-center"
              style={{
                background: "#0f172a",   //SAME as your G-code panel
                padding: "8px 14px",
                minWidth: 590,
                height: 100
              }}
            >
              <div style={{ fontSize: fontSize * 1.5, fontWeight: 600, color: "#94a3b8" }}>
                Active GCodes
              </div>
              <div
                className="font-mono"
                style={{ fontSize: fontSize * 0.75, color: "#22c55e" }}
              >
                {activeGcodes || ""}
              </div>
            </div>            
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
                <Slider label="Spindle Rate" labelW={sliderLabelW} fontSize={20} />
              </div>
        </div>

        {/* ROW 3 — Charts */}
        <div
          className="flex-1 min-h-0 grid grid-rows-2"
          style={{ gap, height: "150px" }}
        >
          {/* SPINDLE RPM */}
          <div
            className="rounded border border-slate-700"
            style={{ background: "#0f172a" }}
          >
            <div className="text-gray-400 text-sm mb-1">Spindle RPM</div>
            {rpmData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rpmData}>
                  <XAxis hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Line type="monotone" dataKey="rpm" stroke="#22c55e" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart label="Spindle RPM" />
            )}
          </div>

          {/* FEED RATE */}
          <div
            className="rounded border border-slate-700"
            style={{ background: "#0f172a"}}
          >
            <div className="text-gray-400 text-sm mb-1">Feed Rate (mm/s)</div>
            {feedData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={feedData}>
                  <XAxis hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Line type="monotone" dataKey="feed" stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart label="Feed Rate (mm/s)" />
            )}
          </div>
        </div>


        {/* ROW 4 — GCode */}
        <div
          className="rounded border border-slate-700 overflow-auto shrink-0"
          style={{ background: "#0f172a", height: `${gcodeHeight}px`, padding: gcodePadding }}
        >
          <p className="text-gray-500 uppercase tracking-widest" style={{ fontSize: fontSize * 0.75 }}>
            G-Code
          </p>

          <div className="font-mono" style={{ fontSize: fontSize * gcodeFontScale, lineHeight: 1.5 }}>
            {gcodeLines.length === 0 ? (
              <div className="text-gray-500 mb-2">No file loaded</div>
            ) : (
              gcodeLines.map((l, i) => {
                const line = l.trim() 
                const active = i + 1 === currentLine

                return (
                  <div
                    key={i}
                    style={{
                      background: active ? "#1e293b" : "transparent",
                      color: active ? "#22c55e" : "#9ca3af",
                      padding: "2px 6px",
                      whiteSpace: "pre" 
                    }}
                  >
                    {String(i + 1).padStart(4, "0")}  {line}
                  </div>
                )
              })
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   EMPTY CHART
══════════════════════════════════════════════════════════════ */
function EmptyChart({ label }: { label: string }) {
  return (
    <div
      style={{
        height: "100%", // 🔥 FIXED
        border: "1px solid #334155",
        borderRadius: 6,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        padding: "10px",
        color: "#64748b",
        fontSize: 12,
        boxSizing: "border-box"

      }}
    >
      <span>{label}</span>
      <span>Time (s)</span>
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
      const fs = Math.max(size * 0.02, 8);
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
  const handleHome = () => {
    fetch(`http://localhost:8000/pocketnc/home?axis=${label}`, {
      method: "POST",
    });
  };
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
      <button
        onClick={handleHome}
        className="bg-slate-700 hover:bg-green-600 text-white rounded"
        style={{
          fontSize: fontSize * 1,
          padding: "2px 6px",
          marginTop: 2
        }}
      >
        ⌂
      </button>
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
        onChange={(e) => {
          const newVal = Number(e.target.value);
          setVal(newVal);
        
          const normalized = newVal / 100;
        
          if (label === "Feed Rate") {
            fetch(`http://localhost:8000/pocketnc/feed?value=${normalized}`, { method: "POST" });
          }
        
          if (label === "Max Rapid") {
            fetch(`http://localhost:8000/pocketnc/rapid?value=${normalized}`, { method: "POST" });
          }
        
          if (label === "Spindle Rate") {
            fetch(`http://localhost:8000/pocketnc/spindle?value=${normalized}`, { method: "POST" });
          }
        }}
        className="flex-1 accent-green-500" />
      <span className="text-gray-400" style={{ fontSize: fontSize * 0.82, width: 10, textAlign: "right" }}>
        {Math.round(val / 10)}
      </span>
    </div>
  );
}
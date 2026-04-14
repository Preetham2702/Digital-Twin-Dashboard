import React, { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer } from "recharts";

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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/* ══════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════ */
export default function PocketNC({ onConnectionChange }: any) {
  const [status, setStatus] = useState<any>({});
  const { w, h } = useWindowSize();
  const [files, setFiles] = useState<string[]>([]);
  const [runLine, setRunLine] = useState(0);
  const [currentLine, setCurrentLine] = useState(0);
  const [currentFile, setCurrentFile] = useState("");
  const [gcodeLines, setGcodeLines] = useState<string[]>([]);
  const [rpmData, setRpmData] = useState<{ time: number; rpm: number }[]>([]);
  const [feedData, setFeedData] = useState<{ time: number; feed: number }[]>([]);
  const [activeGcodes, setActiveGcodes] = useState("");

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:8000/ws/pocketnc");

    fetch("http://localhost:8000/pocketnc/files")
      .then((res) => res.json())
      .then((d) => d.files && setFiles(d.files))
      .catch(console.log);

    onConnectionChange?.(null);

    const fetchGcode = (file: string) => {
      if (!file) return;
      fetch(`http://localhost:8000/pocketnc/file-content?file=${file}`)
        .then((res) => res.json())
        .then((d) => d.lines && setGcodeLines(d.lines))
        .catch(console.log);
    };

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);

      onConnectionChange?.(d?.connected ?? false);

      if (d?.raw_status) {
        const s = d.raw_status;

        setStatus(s);
        setActiveGcodes(s?.active_gcodes || "");

        const line = s?.current_line || 0;
        const file = s?.current_file || "";

        setCurrentLine(line);

        setCurrentFile((prev) => {
          if (file && prev !== file) {
            fetchGcode(file);  
          }
          return file;
        });

        const sValue = d?.raw_status?.s_value ?? 0;
        const fValue = d?.raw_status?.f_value ?? 0;
        setRpmData(prev => {
          const updated = [
            ...prev,
            { time: Date.now(), rpm: sValue }
          ];
          return updated.slice(-50);
        });

        setFeedData(prev => {
          const updated = [
            ...prev,
            { time: Date.now(), feed: fValue }
          ];
          return updated.slice(-50);
        });
      }
    };

    ws.onclose = () => onConnectionChange?.(false);
    ws.onerror = () => onConnectionChange?.(false);

    return () => ws.close();
  }, [onConnectionChange]);
  const position = status?.toolhead?.position ?? [0, 0, 0, 0, 0];

  const spindle = status?.spindle_speed || 0;
  const feed = status?.feed_rate || 0;

  // ╔══════════════════════════════════════════════════════╗
  // ║          LAYOUT TUNING — values only                ║
  // ╠══════════════════════════════════════════════════════╣
  const EFFECTIVE_W_MAX = 1450;
  const EFFECTIVE_H_MAX = 860;

  const LEFT_PANEL_PCT = 0.29;
  const LEFT_PANEL_MIN = 270;
  const LEFT_PANEL_MAX = 420;

  const GAUGE_PCT = 0.22;
  const GAUGE_MIN = 145;
  const GAUGE_MAX = 190;

  const AXIS_BOX_W_PCT = 0.084;
  const AXIS_BOX_W_MIN = 130;
  const AXIS_BOX_W_MAX = 150;
  const AXIS_BOX_H_RATIO = 0.43;
  const AXIS_BOX_GAP = 14;

  const GCODE_PCT = 0.24;
  const GCODE_MIN = 165;
  const GCODE_MAX = 210;

  const STREAM_PCT = 0.56;
  const STREAM_MIN = 290;
  const STREAM_MAX = 400;

  const SLIDER_LABEL_PCT = 0.12;
  const SLIDER_LABEL_MIN = 95;
  const SLIDER_LABEL_MAX = 125;

  const FONT_PCT = 0.009;
  const FONT_MIN = 11;
  const FONT_MAX = 14;

  const PAD_PCT = 0.016;
  const GAP_PCT = 0.012;
  // ╚══════════════════════════════════════════════════════╝

  const effectiveW = Math.min(w, EFFECTIVE_W_MAX);
  const effectiveH = Math.min(h, EFFECTIVE_H_MAX);

  const leftW = Math.round(clamp(effectiveW * LEFT_PANEL_PCT, LEFT_PANEL_MIN, LEFT_PANEL_MAX));
  const effectiveRightW = effectiveW - leftW;
  const rightW = w - leftW;

  const gaugeSize = Math.round(clamp(effectiveH * GAUGE_PCT, GAUGE_MIN, GAUGE_MAX));
  const axisH = Math.round(gaugeSize * AXIS_BOX_H_RATIO);
  const axisW = Math.round(clamp(effectiveRightW * AXIS_BOX_W_PCT, AXIS_BOX_W_MIN, AXIS_BOX_W_MAX));
  const gcodeH = Math.round(clamp(effectiveH * GCODE_PCT, GCODE_MIN, GCODE_MAX));
  const sliderLabelW = Math.round(
    clamp(effectiveRightW * SLIDER_LABEL_PCT, SLIDER_LABEL_MIN, SLIDER_LABEL_MAX)
  );
  const fontSize = Math.round(clamp(effectiveW * FONT_PCT, FONT_MIN, FONT_MAX));
  const pad = Math.round(effectiveH * PAD_PCT);
  const gap = Math.round(effectiveH * GAP_PCT);
  const streamH = Math.round(clamp(effectiveH * STREAM_PCT, STREAM_MIN, STREAM_MAX));

  const row1Gap = Math.round(clamp(effectiveRightW * 0.035, 26, 42));
  const axisRowMarginLeft = Math.round(clamp(effectiveRightW * 0.018, 10, 18));
  const activeCodesWidth = Math.round(clamp(effectiveRightW * 0.43, 700, 700));
  const activeCodesHeight = Math.round(clamp(effectiveH * 0.12, 88, 108));
  const sliderGap = Math.round(clamp(effectiveH * 0.012, 8, 12));
  const sliderSectionGap = Math.round(clamp(effectiveRightW * 0.04, 22, 36));
  const sliderFontSize = Math.round(clamp(fontSize * 1.45, 16, 20));
  const chartSectionHeight = Math.round(clamp(effectiveH * 0.38, 285, 340));
  const chartTitleHeight = Math.round(clamp(fontSize * 1.7, 20, 24));
  const gcodeHeight = gcodeH;
  const gcodePadding = "10px 12px";
  const gcodeFontScale = 0.82;

  const start = () =>
    fetch("http://localhost:8000/pocketnc/start", { method: "POST" });

  const stop = () =>
    fetch("http://localhost:8000/pocketnc/stop", { method: "POST" });

  const isPaused = status?.interp_state === 3;
  const isRunning = status?.interp_state === 2;
  return (
    <div
      className="overflow-hidden flex text-gray-200"
      style={{ background: "#1e293b", width: "100vw", height: "95vh", fontSize }}
    >
      {/* ═══════════ LEFT PANEL ═══════════ */}
      <div
        className="shrink-0 flex flex-col border-r border-slate-600"
        style={{
          width: leftW,
          padding: Math.round(leftW * 0.055),
          gap: Math.round(leftW * 0.05),
          background: "#1e293b",
        }}
      >
        <button
          onClick={() => fetch("http://localhost:8000/pocketnc/estop", { method: "POST" })}
          className="w-full bg-red-500 hover:bg-red-600 text-white font-bold rounded tracking-widest"
        >
          E-STOP
        </button>

        <div>
          <p className="text-gray-400" style={{ fontSize: fontSize * 1.3, marginBottom: 6 }}>
            Upload File
          </p>
          <input
            type="file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;

              await fetch(`http://localhost:8000/pocketnc/load?file=${file.name}`, {
                method: "POST",
              });
            }}
            className="w-full rounded border border-slate-700 text-gray-300"
            style={{
              background: "#0f172a",
              fontSize: fontSize,
              padding: `${Math.round(gaugeSize * 0.08)}px ${Math.round(gaugeSize * 0.06)}px`,
              height: Math.round(gaugeSize * 0.26),
            }}
          />
        </div>

        <div>
          <p className="text-gray-400" style={{ fontSize: fontSize * 1.3, marginBottom: 6 }}>
            Existing File
          </p>
          <div
            className="w-full border border-slate-600 rounded flex items-center text-gray-500"
            style={{
              background: "#0f172a",
              fontSize: fontSize,
              padding: `${Math.round(gaugeSize * 0.08)}px ${Math.round(gaugeSize * 0.06)}px`,
              height: Math.round(gaugeSize * 0.26),
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
                        .then((res) => res.json())
                        .then((d) => d.files && setFiles(d.files));
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
          <button
            disabled={false}
            onClick={() => {
              console.log("PAUSE CLICKED");   // 🔥 ADD THIS
            
              if (isPaused) {
                fetch("http://localhost:8000/pocketnc/start", { method: "POST" });
              } else {
                fetch("http://localhost:8000/pocketnc/pause", { method: "POST" });
              }
            }}
            className={`flex-1 rounded ${
              isPaused ? "bg-blue-500" : "bg-yellow-500"
            }`}
          >
            {isPaused ? "▶" : "⏸"}
          </button>

          <button onClick={stop} className="flex-1 bg-red-600 rounded">■</button>
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

        <div
          className="rounded border border-slate-600 flex items-center justify-center"
          style={{ background: "#0f172a", height: 600, flexShrink: 0 }}
        >
          <span className="text-gray-600" style={{ fontSize: fontSize * 0.82 }}>
            Live Streaming
          </span>
        </div>
      </div>

      {/* ═══════════ RIGHT PANEL ═══════════ */}
      <div
        className="flex-1 min-w-0 flex flex-col overflow-hidden"
        style={{ padding: pad, gap }}
      >
        {/* ROW 1 */}
        <div className="flex items-center shrink-0" style={{ gap: row1Gap }}>
          <GaugeBlock
            label="Spindle"
            value={spindle}
            max={24000}
            unit="RPM"
            rings={["Power", "Load", "Temp"]}
            size={gaugeSize}
            fontSize={fontSize}
          />

          <GaugeBlock
            label="Feed"
            value={feed}
            max={2000}
            unit="In/min"
            rings={["Power", "Chip Load", "Surface Speed"]}
            size={gaugeSize}
            fontSize={fontSize}
          />

          <div className="flex flex-col items-center" style={{ gap: 10 }}>
            <div
              className="flex items-center"
              style={{ gap: AXIS_BOX_GAP, marginLeft: axisRowMarginLeft }}
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

            <button
              onClick={() =>
                fetch("http://localhost:8000/pocketnc/home_all", {
                  method: "POST",
                })
              }
              className="bg-slate-700 hover:bg-green-600 text-white rounded"
              style={{
                padding: "10px 16px",
                fontSize: 15,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              ⌂ Home All
            </button>

            <div
              className="rounded border border-slate-700 text-center"
              style={{
                background: "#0f172a",
                padding: "8px 14px",
                minWidth: activeCodesWidth,
                height: activeCodesHeight,
              }}
            >
              <div
                className="font-mono"
                style={{ fontSize: fontSize * 1.5, color: "#22c55e" }}
              >
                {(activeGcodes || "")
                  .split(" ")
                  .reduce<string[][]>(
                    (acc, code) => {
                      if (code.startsWith("G")) acc[0].push(code);
                      else if (code.startsWith("M")) acc[1].push(code);
                      else if (code.startsWith("F") || code.startsWith("S")) acc[2].push(code);
                      return acc;
                    },
                    [[], [], []]
                  )
                  .map((group, i) =>
                    group.length > 0 ? (
                      <div key={i}>{group.join(" ")}</div>
                    ) : null
                  )}
              </div>
            </div>
          </div>
        </div>

        {/* ROW 2 */}
        <div className="flex shrink-0" style={{ gap: sliderSectionGap }}>
          <div className="flex-1 flex flex-col" style={{ gap: sliderGap }}>
            <Slider label="Max Velocity" labelW={sliderLabelW} fontSize={sliderFontSize} />
            <Slider label="Feed Rate" labelW={sliderLabelW} fontSize={sliderFontSize} />
          </div>

          <div className="flex-1 flex flex-col" style={{ gap: sliderGap }}>
            <Slider label="Spindle Rate" labelW={sliderLabelW} fontSize={sliderFontSize} />
          </div>
        </div>

        {/* ROW 3 */}
        <div
          className="flex-1 min-h-0 grid grid-rows-2"
          style={{ gap, height: `${chartSectionHeight}px` }}
        >
          <ChartPanel
            title="Spindle RPM"
            titleHeight={chartTitleHeight}
            data={rpmData}
            dataKey="rpm"
            stroke="#22c55e"
            emptyLabel="Spindle RPM"
          />

          <ChartPanel
            title="Feed Rate (mm/s)"
            titleHeight={chartTitleHeight}
            data={feedData}
            dataKey="feed"
            stroke="#38bdf8"
            emptyLabel="Feed Rate (mm/s)"
          />
        </div>

        {/* ROW 4 */}
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
                const line = l.trim();
                const active = i + 1 === currentLine;

                return (
                  <div
                    key={i}
                    style={{
                      background: active ? "#1e293b" : "transparent",
                      color: active ? "#22c55e" : "#9ca3af",
                      padding: "2px 6px",
                      whiteSpace: "pre",
                    }}
                  >
                    {String(i + 1).padStart(4, "0")}  {line}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   CHART PANEL
══════════════════════════════════════════════════════════════ */
function ChartPanel({
  title,
  titleHeight,
  data,
  dataKey,
  stroke,
  emptyLabel,
}: {
  title: string;
  titleHeight: number;
  data: { time: number; [key: string]: number }[];
  dataKey: string;
  stroke: string;
  emptyLabel: string;
}) {
  return (
    <div className="rounded border border-slate-700 p-2" style={{ background: "#0f172a" }}>
      <div className="text-gray-400 text-sm mb-1" style={{ height: titleHeight }}>
        {title}
      </div>

      <div style={{ height: `calc(100% - ${titleHeight}px)` }}>
        {data.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <XAxis hide />
              <YAxis hide domain={["auto", "auto"]} />
              <Line
                type="monotone"
                dataKey={dataKey}
                stroke={stroke}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label={emptyLabel} />
        )}
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
        height: "100%",
        border: "1px solid #334155",
        borderRadius: 6,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        padding: "10px",
        color: "#64748b",
        fontSize: 12,
        boxSizing: "border-box",
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
      <p
        className="text-gray-300 font-bold uppercase tracking-widest"
        style={{ fontSize: fontSize * 0.85, letterSpacing: "0.15em" }}
      >
        {label}
      </p>
      <SegmentedRingGauge value={value} max={max} unit={unit} rings={rings} size={size} />
    </div>
  );
}

function SegmentedRingGauge({ value, max, unit, rings, size }: any) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.42;
  const segW = Math.max(size * 0.055, 6);

  const toRad = (d: number) => (d * Math.PI) / 180;

  const arcDefs = [
    { startDeg: 200, endDeg: 310, label: rings[0] },
    { startDeg: 350, endDeg: 460, label: rings[1] },
    { startDeg: 130, endDeg: 200, label: rings[2] },
  ] as const;

  const frac = Math.min(value / max, 1);

  function segColor(arcIdx: number, segIdx: number, total: number) {
    const t = segIdx / total;
    if (arcIdx === 0) {
      if (t < 0.5) return "#4ade80";
      if (t < 0.8) return "#a3e635";
      return "#facc15";
    }
    if (arcIdx === 1) {
      if (t < 0.5) return "#4ade80";
      if (t < 0.75) return "#a3e635";
      return "#facc15";
    }
    if (t < 0.4) return "#2dd4bf";
    if (t < 0.8) return "#4ade80";
    return "#a3e635";
  }

  function buildSegments(startDeg: number, endDeg: number, arcIdx: number) {
    const spanDeg = endDeg - startDeg;
    const nSegs = Math.round(spanDeg / 8);
    const ticks = [];

    for (let i = 0; i < nSegs; i++) {
      const t = i / (nSegs - 1);
      const aDeg = startDeg + (spanDeg * i) / (nSegs - 1);
      const aRad = toRad(aDeg);
      const r1 = R - segW / 2;
      const r2 = R + segW / 2;
      const cos = Math.cos(aRad);
      const sin = Math.sin(aRad);
      const filled = frac > t;
      const color = filled ? segColor(arcIdx, i, nSegs) : "#1e3a52";

      ticks.push(
        <line
          key={i}
          x1={cx + r1 * cos}
          y1={cy + r1 * sin}
          x2={cx + r2 * cos}
          y2={cy + r2 * sin}
          stroke={color}
          strokeWidth={Math.max(size * 0.018, 2.5)}
          strokeLinecap="round"
        />
      );
    }

    return ticks;
  }

  function curvedLabel(startDeg: number, endDeg: number, text: string, idx: number) {
    const midDeg = (startDeg + endDeg) / 2;
    const labelR = R - size * 0.085;
    const sDeg = midDeg - 30;
    const eDeg = midDeg + 30;
    const x1 = cx + labelR * Math.cos(toRad(sDeg));
    const y1 = cy + labelR * Math.sin(toRad(sDeg));
    const x2 = cx + labelR * Math.cos(toRad(eDeg));
    const y2 = cy + labelR * Math.sin(toRad(eDeg));
    const id = `arc-label-${idx}`;
    const fs = Math.max(size * 0.02, 8);

    return (
      <g key={idx}>
        <defs>
          <path id={id} d={`M ${x1} ${y1} A ${labelR} ${labelR} 0 0 1 ${x2} ${y2}`} />
        </defs>
        <text
          fill="#94a3b8"
          fontSize={fs}
          fontWeight="600"
          letterSpacing="0.08em"
          style={{ textTransform: "uppercase" }}
        >
          <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
            {text}
          </textPath>
        </text>
      </g>
    );
  }

  const valFS = Math.max(size * 0.18, 20);
  const unitFS = Math.max(size * 0.07, 9);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {arcDefs.map((arc, i) => buildSegments(arc.startDeg, arc.endDeg, i))}
      {arcDefs.map((arc, i) => curvedLabel(arc.startDeg, arc.endDeg, arc.label, i))}

      <text
        x={cx}
        y={cy + valFS * 0.35}
        textAnchor="middle"
        fill="white"
        fontSize={valFS}
        fontWeight="bold"
        fontFamily="monospace"
      >
        {value.toFixed(0)}
      </text>

      <text
        x={cx}
        y={cy + valFS * 0.35 + unitFS * 1.5}
        textAnchor="middle"
        fill="#64748b"
        fontSize={unitFS}
        fontWeight="600"
        letterSpacing="0.1em"
      >
        {unit.toUpperCase()}
      </text>
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════
   AXIS BOX
══════════════════════════════════════════════════════════════ */
function AxisBox({ label, value, w, h, fontSize }: any) {
  const handleHome = () => {
    fetch(`http://localhost:8000/pocketnc/home?axis=${label}`, {
      method: "POST",
    });
  };

  return (
    <div
      className="rounded-lg flex flex-col items-center justify-center border border-slate-500"
      style={{ background: "#0f172a", width: 130, height: 100, gap: 4 }}
    >
      <span
        className="text-gray-400 font-semibold uppercase tracking-wider"
        style={{ fontSize: fontSize * 1 }}
      >
        {label}
      </span>

      <span className="text-green-400 font-bold" style={{ fontSize: fontSize * 1.1 }}>
        {typeof value === "number" ? value.toFixed(3) : value}
      </span>

      <button
        onClick={handleHome}
        className="bg-slate-600 hover:bg-green-500 text-white rounded"
        style={{
          fontSize: 13,
          padding: "3px 8px",
          marginTop: 2,
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
      <p className="text-gray-400 shrink-0" style={{ fontSize: fontSize * 0.82, width: labelW }}>
        {label}
      </p>

      <input
        type="range"
        min={0}
        max={200}
        value={val}
        onChange={(e) => {
          const newVal = Number(e.target.value);
          setVal(newVal);

          const normalized = newVal / 100;

          if (label === "Feed Rate") {
            fetch(`http://localhost:8000/pocketnc/feed?value=${normalized}`, { method: "POST" });
          }

          if (label === "Max Velocity") {
            fetch(`http://localhost:8000/pocketnc/velocity?value=${normalized}`, { method: "POST" });
          }

          if (label === "Spindle Rate") {
            fetch(`http://localhost:8000/pocketnc/spindle?value=${normalized}`, { method: "POST" });
          }
        }}
        className="flex-1 accent-green-500"
      />

      <span
        className="text-gray-400"
        style={{ fontSize: fontSize * 0.82, width: 10, textAlign: "right" }}
      >
        {Math.round(val / 10)}
      </span>
    </div>
  );
}

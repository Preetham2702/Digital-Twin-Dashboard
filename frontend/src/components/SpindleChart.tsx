import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer
} from "recharts"

interface Props {
  data: {
    spindle_speed: number
  }[]
}

export default function SpindleChart({ data }: Props) {

  const safeData = data.map((d, i) => ({
    index: i,
    spindle_speed: Math.min(d.spindle_speed ?? 0, 24000)
  }))

  return (

    <div className="bg-slate-800 p-6 rounded border border-slate-700 h-80">

      <h3 className="mb-4 text-white text-lg font-semibold">
        Spindle Speed
      </h3>

      <ResponsiveContainer width="100%" height="85%">
        <LineChart data={safeData}>

          <CartesianGrid stroke="#334155" strokeDasharray="3 3"/>

          <XAxis
            dataKey="index"
            stroke="#94a3b8"
            label={{
              value: "Updates",
              position: "insideBottomRight",
              offset: -5,
              fill: "#94a3b8"
            }}
          />

          <YAxis
            stroke="#94a3b8"
            domain={[0,24000]}
            label={{
              value: "RPM",
              angle: -90,
              position: "insideLeft",
              fill: "#94a3b8"
            }}
          />

          <Tooltip
            formatter={(v: number | undefined) => v !== undefined ? `${v} RPM` : 'N/A'}
          />

          <Line
            type="monotone"
            dataKey="spindle_speed"
            stroke="#a855f7"
            strokeWidth={2}
            dot={false}
          />

        </LineChart>
      </ResponsiveContainer>

    </div>
  )
}
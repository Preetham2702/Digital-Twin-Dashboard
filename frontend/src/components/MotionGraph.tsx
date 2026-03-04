import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
    ResponsiveContainer,
    Legend
  } from "recharts"
  
  interface Props {
    data: { time: number; feed: number; velocity: number }[]
  }
  
  export default function MotionGraph({ data }: Props) {
  
    // Clamp values to realistic printer max
    const safeData = data.map(d => ({
      ...d,
      feed: Math.min(d.feed ?? 0, 650),
      velocity: Math.min(d.velocity ?? 0, 650)
    }))
  
    return (
      <div className="bg-slate-800 p-6 rounded border border-slate-700 h-80">
  
        <h3 className="mb-4 text-white text-lg md:text-xl font-semibold">
          Motion Analysis (Feed vs Live Velocity)
        </h3>
  
        <ResponsiveContainer width="100%" height="85%">
          <LineChart data={safeData}>
  
            <CartesianGrid
              stroke="#334155"
              strokeDasharray="3 3"
            />
  
            <XAxis
              dataKey="time"
              stroke="#94a3b8"
              tick={{ fontSize: 12 }}
              label={{
                value: "Time (s)",
                position: "insideBottomRight",
                offset: -5,
                fill: "#94a3b8"
              }}
            />
  
            <YAxis
              stroke="#94a3b8"
              domain={[0, 650]}
              tick={{ fontSize: 12 }}
              label={{
                value: "Speed (mm/s)",
                angle: -90,
                position: "insideLeft",
                fill: "#94a3b8"
              }}
            />
  
            <Tooltip
              contentStyle={{
                backgroundColor: "#1e293b",
                borderColor: "#475569",
                color: "white"
              }}
              formatter={(value: number | undefined) => value !== undefined ? `${value.toFixed(1)} mm/s` : 'N/A'}
            />
  
            <Legend wrapperStyle={{ color: "#cbd5e1" }} />
  
            <Line
              type="monotone"
              dataKey="feed"
              name="Commanded Feed"
              stroke="#a855f7"
              dot={false}
              strokeWidth={2}
            />
  
            <Line
              type="monotone"
              dataKey="velocity"
              name="Live Velocity"
              stroke="#22c55e"
              dot={false}
              strokeWidth={2}
            />
  
          </LineChart>
        </ResponsiveContainer>
      </div>
    )
  }
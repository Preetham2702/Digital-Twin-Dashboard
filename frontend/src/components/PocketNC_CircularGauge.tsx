export default function CircularGauge({
  value,
  max = 24000,
  label = "FEED",
  unit = "IN/MIN"
}: { value: number; max?: number; label?: string; unit?: string }) {
  const radius = 120
  const stroke = 18
  const normalized = Math.min(value / max, 1)

  const circumference = 2 * Math.PI * radius
  const dash = circumference * normalized

  return (
    <div className="flex flex-col items-center justify-center">

      <svg width="300" height="300" viewBox="0 0 300 300">

        <circle cx="150" cy="150" r={radius} fill="none" stroke="#1e293b" strokeWidth={stroke} />

        <circle
          cx="150"
          cy="150"
          r={radius}
          fill="none"
          stroke="url(#grad)"
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 150 150)"
          strokeLinecap="round"
        />

        <defs>
          <linearGradient id="grad">
            <stop offset="0%" stopColor="#22c55e" />
            <stop offset="60%" stopColor="#eab308" />
            <stop offset="100%" stopColor="#f97316" />
          </linearGradient>
        </defs>

        <text x="150" y="140" textAnchor="middle" className="fill-white text-3xl font-bold">
          {value.toFixed(0)}
        </text>

        <text x="150" y="170" textAnchor="middle" className="fill-gray-400 text-sm">
          {unit}
        </text>

        <text x="150" y="40" textAnchor="middle" className="fill-gray-400 text-sm">
          {label}
        </text>

      </svg>

    </div>
  )
}

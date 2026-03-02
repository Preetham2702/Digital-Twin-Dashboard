type GaugeProps = {
    value: number
    max: number
    color: string
  }
  
  export default function SemiGauge({ value, max, color }: GaugeProps) {
    const radius = 70
    const strokeWidth = 12
    const normalizedValue = Math.min(value / max, 1)
  
    const circumference = Math.PI * radius
    const offset = circumference * (1 - normalizedValue)
  
    return (
      <svg width="180" height="110" viewBox="0 0 180 110">
        <path
          d="M20 90 A70 70 0 0 1 160 90"
          fill="transparent"
          stroke="#334155"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        <path
          d="M20 90 A70 70 0 0 1 160 90"
          fill="transparent"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.3s ease" }}
        />
        <text
          x="90"
          y="75"
          textAnchor="middle"
          className="fill-white text-lg"
        >
          {Math.round(value)}°C
        </text>
      </svg>
    )
  }
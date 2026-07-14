// src/components/BedAlert.tsx
// Non-blocking banner shown when a finished print is still on the FDM bed.
// Stays up until the bed is detected clear (or the operator dismisses it).

type Props = {
  visible: boolean
  filename?: string
  onAcknowledge?: () => void
  onDismiss?: () => void
}

export default function BedAlert({ visible, filename, onAcknowledge, onDismiss }: Props) {
  if (!visible) return null

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-600/50 border-l-4 border-l-amber-500 bg-amber-900/30 px-4 py-3">
      <span className="text-amber-400 text-xl leading-none mt-0.5">⚠️</span>

      <div className="flex-1 min-w-0">
        <p className="text-amber-200 font-semibold text-sm">Print not removed</p>
        <p className="text-amber-300/70 text-xs mt-0.5 truncate">
          {filename ? `${filename} finished — ` : ""}part still on the bed. Clear it before the next print.
        </p>
      </div>

      {onAcknowledge && (
        <button
          onClick={onAcknowledge}
          className="shrink-0 text-xs px-3 py-1 rounded bg-amber-800/60 hover:bg-amber-700 text-amber-100 transition-colors"
        >
          Acknowledge
        </button>
      )}

      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-amber-400/70 hover:text-amber-200 text-lg leading-none px-1"
        >
          ✕
        </button>
      )}
    </div>
  )
}
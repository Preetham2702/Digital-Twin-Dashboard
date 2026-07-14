// src/components/ConnectionOverlay.tsx
// Centered rotating spinner shown when the backend has lost its link to the
// printer. Rendered as an absolute layer over the printer page, so it sits in
// the middle of the available screen area (below the top nav bar).

export default function ConnectionOverlay({
  message = "Waiting for connection",
}: {
  message?: string
}) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-slate-900/80 backdrop-blur-sm">
      <div className="w-12 h-12 rounded-full border-4 border-slate-600 border-t-green-400 animate-spin" />
      <p className="text-slate-300 text-sm tracking-wide">{message}</p>
    </div>
  )
}
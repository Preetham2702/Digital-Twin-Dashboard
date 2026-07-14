// src/types/machine.ts
// Shared shape for the fleet overview. Each printer component reports one of
// these up to Dashboard via the optional `onSummary` prop.

export type MachineId = "FDM" | "Resin" | "PocketNC" | "Hybrid-Cell"

export type MachineStatus =
  | "running"
  | "idle"
  | "fault"
  | "offline"
  | "connecting"

export interface MachineTemp {
  label: string // "Nozzle", "Bed", "UV LED", "Tank", "Spindle"...
  value: number | null
  unit?: string // defaults to "°C" in the UI
}

export interface MachineSummary {
  status: MachineStatus
  progress: number | null // 0–100 while active, null when not printing / cutting
  temps: MachineTemp[]
  detail?: string // optional: job name, layer count, or error text
}
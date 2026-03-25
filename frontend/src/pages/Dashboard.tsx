import { useState, useEffect } from "react"
import FDM from "../printers/FDMPrinter"
import Resin from "../printers/ResinPrinter"


export default function Dashboard() {

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [selectedMachine, setSelectedMachine] = useState(() => {
    return localStorage.getItem("machine") || "FDM"
  })

  // ✅ CONNECTION STATES
  const [fdmConnected, setFdmConnected] = useState<boolean | null>(null)
  const [resinConnected, setResinConnected] = useState<boolean | null>(null)
  useEffect(() => {
    localStorage.setItem("machine", selectedMachine)
  }, [selectedMachine])

  return (
    <div className="h-screen bg-slate-900 text-gray-200 flex flex-col relative">

      {/* OVERLAY */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* SIDEBAR */}
      <div className={`fixed top-0 left-0 h-full w-80 bg-slate-900 border-r border-slate-700 z-50 transform transition-transform duration-300 ${
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      }`}>
        <div className="h-14 flex items-center justify-between px-6 border-b border-slate-700">
          <span className="text-white font-semibold">Machines</span>
          <button onClick={() => setSidebarOpen(false)} className="text-xl text-slate-400 hover:text-white">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-3">
          {["FDM", "Resin", "PocketNC"].map((machine) => (
            <button
              key={machine}
              onClick={() => {
                setSelectedMachine(machine)
                setSidebarOpen(false)
              }}
              className={`w-full text-left px-4 py-3 text-lg rounded ${
                selectedMachine === machine
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {machine === "PocketNC"
                ? "Pocket NC"
                : `${machine} Machine`}
            </button>
          ))}
        </div>
      </div>

      {/* TOP BAR */}
      <header className="h-16 bg-slate-800 border-b border-slate-700 flex items-center px-6 justify-between">

        {/* LEFT */}
        <div className="flex items-center">
          <button onClick={() => setSidebarOpen(true)} className="text-white text-2xl">
            ☰
          </button>

          <span className="ml-6 text-lg font-semibold">
            {selectedMachine === "PocketNC"
              ? "Pocket NC"
              : `${selectedMachine} Machine`}
          </span>
        </div>

        {/* 🔥 RIGHT SIDE CONNECTION STATUS */}
        <div className="flex items-center gap-6 text-sm">

          <Connection label="FDM" value={fdmConnected} />
          <Connection label="Resin" value={resinConnected} />

        </div>

      </header>

      {/* MACHINE VIEW */}
      <div className={selectedMachine === "FDM" ? "block" : "hidden"}>
        <FDM onConnectionChange={setFdmConnected} />
      </div>


      <div className={selectedMachine === "Resin" ? "block" : "hidden"}>
        <Resin onConnectionChange={setResinConnected} />
      </div>



    </div>
  )
}

/* 🔥 CONNECTION UI */
function Connection({ label, value }: { label: string; value: boolean | null }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-400">{label}:</span>

      <div className="flex items-center gap-2">
        
        {/* 🔥 SPINNER */}
        {value === null && (
          <div className="w-3 h-3 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
        )}

        <span
          className={
            value === null
              ? "text-yellow-400"
              : value
              ? "text-green-400"
              : "text-red-400"
          }
        >
          {value === null
            ? "Connecting..."
            : value
            ? "Connected"
            : "Disconnected"}
        </span>

      </div>
    </div>
  )
}
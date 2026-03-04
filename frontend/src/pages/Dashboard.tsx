import { useEffect, useState } from "react"
import FDM from "../printers/FDMPrinter"
import Resin from "../printers/ResinPrinter"
import PocketNC from "../printers/PocketNC"

export default function Dashboard() {

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [selectedMachine, setSelectedMachine] = useState("FDM")
  const [connected, setConnected] = useState(false)

  // =============================
  // GLOBAL MOONRAKER CONNECTION
  // =============================
  useEffect(() => {
    const socket = new WebSocket("ws://localhost:8000/ws/printer")

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data)
      setConnected(data.moonraker_connected ?? false)
    }

    socket.onclose = () => {
      setConnected(false)
    }

    return () => socket.close()
  }, [])

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
      <div
        className={`fixed top-0 left-0 h-full w-80 bg-slate-900 border-r border-slate-700 z-50 transform transition-transform duration-300 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="h-14 flex items-center justify-between px-6 border-b border-slate-700">
          <span className="text-white font-semibold">Machines</span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="text-xl text-slate-400 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-3">
          {["FDM", "Resin", "PocketNC"].map((machine) => (
            <button
              key={machine}
              onClick={(e) => {
                // CTRL / CMD click opens in new tab
                if (e.ctrlKey || e.metaKey || e.button === 1) {
                  window.open(`/?machine=${machine}`, "_blank")
                  return
                }

                // Normal click switches view
                setSelectedMachine(machine)
                setSidebarOpen(false)
              }}
              className={`w-full text-left px-4 py-3 text-lg rounded transition ${
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
      <header className="h-16 md:h-18 bg-slate-800 border-b border-slate-700 flex items-center px-6 justify-between">

        <div className="flex items-center">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-white text-2xl md:text-3xl hover:text-slate-300"
          >
            ☰
          </button>

          <span className="ml-6 text-slate-200 font-semibold text-lg md:text-xl lg:text-2xl">
            {selectedMachine === "PocketNC"
              ? "Pocket NC"
              : `${selectedMachine} Machine`}
          </span>
        </div>

      {/* Moonraker Status - Only for FDM */}
      {selectedMachine === "FDM" && (
        <div className="text-base md:text-lg lg:text-xl font-medium flex items-center">
          <span className="mr-2 text-slate-300">
            Moonraker:
          </span>

          <span
            className={`font-semibold ${
              connected ? "text-green-400" : "text-red-400"
            }`}
          >
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      )}

      </header>

      {/* MACHINE VIEW */}
      {selectedMachine === "FDM" && <FDM />}
      {selectedMachine === "Resin" && <Resin />}
      {selectedMachine === "PocketNC" && <PocketNC />}

    </div>
  )
}
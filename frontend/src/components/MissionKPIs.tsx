const stats = [
  { label: "Active Jobs", value: 24 },
  { label: "Running", value: 12 },
  { label: "Queued", value: 8 },
  { label: "Completed", value: 156 },
  { label: "Utilization", value: "82%" },
  { label: "Alerts", value: 3 }
];

export default function MissionKPIs() {
  return (
    <div className="grid grid-cols-6 gap-4">
      {stats.map((item) => (
        <div
          key={item.label}
          className="bg-[#12233D] border border-slate-700 rounded-xl p-4"
        >
          <div className="text-slate-400 text-sm">
            {item.label}
          </div>

          <div className="text-3xl font-bold mt-2">
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}
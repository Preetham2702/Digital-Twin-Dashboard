const events = [
  "Job Started",
  "PocketNC Connected",
  "Material Refilled",
  "Print Completed"
];

export default function EventFeed() {
  return (
    <div className="bg-[#12233D] rounded-xl border border-slate-700 p-4 h-[500px]">
      <h2 className="font-semibold mb-4">
        Live Events
      </h2>

      {events.map((event, index) => (
        <div
          key={index}
          className="border-b border-slate-700 py-3"
        >
          <div>{event}</div>

          <div className="text-xs text-slate-400">
            7:{30 + index} PM
          </div>
        </div>
      ))}
    </div>
  );
}
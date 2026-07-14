export default function Timeline() {
  return (
    <div className="bg-[#12233D] rounded-xl border border-slate-700 p-4">
      <h2 className="font-semibold mb-4">
        Production Timeline
      </h2>

      <div className="space-y-4">
        <div>
          <div className="mb-1">
            Bracket Assembly
          </div>

          <div className="bg-slate-800 h-4 rounded">
            <div className="bg-cyan-400 h-4 w-3/4 rounded" />
          </div>
        </div>

        <div>
          <div className="mb-1">
            Impeller
          </div>

          <div className="bg-slate-800 h-4 rounded">
            <div className="bg-green-400 h-4 w-1/2 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}
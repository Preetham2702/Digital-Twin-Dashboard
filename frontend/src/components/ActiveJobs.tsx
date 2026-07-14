const jobs = [
  {
    name: "Bracket Assembly",
    machine: "FDM",
    progress: 62
  },
  {
    name: "Impeller",
    machine: "PocketNC",
    progress: 34
  },
  {
    name: "Housing",
    machine: "Resin",
    progress: 81
  }
];

export default function ActiveJobs() {
  return (
    <div className="bg-[#12233D] rounded-xl border border-slate-700 p-4">
      <h2 className="font-semibold mb-4">
        Active Missions
      </h2>

      {jobs.map((job) => (
        <div
          key={job.name}
          className="mb-4 border-b border-slate-700 pb-3"
        >
          <div>{job.name}</div>

          <div className="text-sm text-slate-400">
            {job.machine}
          </div>

          <div className="w-full bg-slate-800 rounded-full h-2 mt-2">
            <div
              className="bg-cyan-400 h-2 rounded-full"
              style={{
                width: `${job.progress}%`
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
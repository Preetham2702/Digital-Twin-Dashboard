import MissionKPIs from "../components/MissionKPIs";
import WorldMap from "../components/WorldMap";
import ActiveJobs from "../components/ActiveJobs";
import EventFeed from "../components/EventFeed";
import Timeline from "../components/Timeline";

export default function Mission() {
  return (
    <div className="min-h-screen bg-[#081528] p-6 text-white">
      <h1 className="text-3xl font-bold mb-6">
        Mission Control
      </h1>

      <MissionKPIs />

      <div className="grid grid-cols-12 gap-4 mt-6">
        <div className="col-span-8">
          <WorldMap />
        </div>

        <div className="col-span-4">
          <EventFeed />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 mt-4">
        <div className="col-span-6">
          <ActiveJobs />
        </div>

        <div className="col-span-6">
          <Timeline />
        </div>
      </div>
    </div>
  );
}
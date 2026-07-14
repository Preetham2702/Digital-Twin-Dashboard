import {
  ComposableMap,
  Geographies,
  Geography,
  Marker
} from "react-simple-maps";

const geoUrl =
  "https://raw.githubusercontent.com/deldersveld/topojson/master/world-countries.json";

const locations = [
  { name: "Dallas", coordinates: [-96.79, 32.77] },
  { name: "Germany", coordinates: [10.4, 51.1] },
  { name: "India", coordinates: [78.96, 20.59] },
  { name: "Japan", coordinates: [138.25, 36.2] }
];

export default function WorldMap() {
  return (
    <div className="bg-[#12233D] rounded-xl border border-slate-700 p-4 h-[500px]">
      <h2 className="font-semibold mb-4">
        Global Factory View
      </h2>

      <ComposableMap>
        <Geographies geography={geoUrl}>
          {({ geographies }: { geographies: any[] }) =>
            geographies.map((geo) => (
              <Geography
                key={geo.rsmKey}
                geography={geo}
                fill="#1E3A5F"
                stroke="#314866"
              />
            ))
          }
        </Geographies>

        {locations.map((site) => (
          <Marker
            key={site.name}
            coordinates={site.coordinates}
          >
            <circle r={6} fill="#00E676" />
            <text
              y={-10}
              style={{
                fill: "white",
                fontSize: 12
              }}
            >
              {site.name}
            </text>
          </Marker>
        ))}
      </ComposableMap>
    </div>
  );
}
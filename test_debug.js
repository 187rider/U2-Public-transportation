import fs from 'fs';
let code = fs.readFileSync('web/src/App.jsx', 'utf8');

// Replace the debug UI to include the actual MapLibre source length!
code = code.replace(
  'Route Stations: {selectedRouteStations ? selectedRouteStations.size : "NULL"}</div>',
  'Route Stations: {selectedRouteStations ? selectedRouteStations.size : "NULL"} | Map Features: {map.current ? map.current.querySourceFeatures("stations-source").length : "..."}</div>'
);
fs.writeFileSync('web/src/App.jsx', code);

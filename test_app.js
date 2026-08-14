import fs from 'fs';
let code = fs.readFileSync('web/src/App.jsx', 'utf8');
if (code.includes('selectedRouteStations ? selectedRouteStations.size')) {
  console.log("Already has debug UI");
} else {
  code = code.replace(
    'return (',
    'return (<div style={{position:"absolute", zIndex: 9999, top: 100, left: 50, background:"white", padding: 10, color: "black", fontWeight: "bold", fontSize: 20}}>Route Stations: {selectedRouteStations ? selectedRouteStations.size : "NULL"}</div>\n  '
  );
  fs.writeFileSync('web/src/App.jsx', code);
  console.log("Added debug UI");
}

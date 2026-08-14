import fs from 'fs';
let code = fs.readFileSync('web/src/App.jsx', 'utf8');
code = code.replace(
  'const filtered = (stationsRef.current || []).filter((st) => {',
  `const filtered = (stationsRef.current || []).filter((st) => {
      if (selectedRouteStations) {
        // Strict filtering! If it's not in the set, get rid of it completely!
        if (!selectedRouteStations.has(st.properties.id)) return false;
      }`
);
fs.writeFileSync('web/src/App.jsx', code);

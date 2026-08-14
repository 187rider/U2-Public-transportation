const forecasts = [
  { stid: 1, time: "5" },
  { stid: 2, time: "10" },
  { stid: 1, time: "65" }
];
const unique = [];
const seen = new Set();
forecasts.forEach(f => {
  if (!seen.has(f.stid)) {
    seen.add(f.stid);
    unique.push(f);
  }
});
console.log(unique);

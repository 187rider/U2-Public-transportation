const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => {
    if (msg.text().includes("Filtered") || msg.text().includes("Route stations API")) {
      console.log('PAGE LOG:', msg.text());
    }
  });
  
  await page.goto('http://127.0.0.1:5173/');
  
  // Wait for map and vehicles to load
  await page.waitForTimeout(5000);
  
  const markers = await page.$$('.vehicle-marker');
  if (markers.length > 0) {
    console.log("Found", markers.length, "vehicles. Clicking the first one...");
    await markers[0].click();
    await page.waitForTimeout(3000);
  } else {
    console.log("No vehicles found on screen!");
  }

  await browser.close();
})();

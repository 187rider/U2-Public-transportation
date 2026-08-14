import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes("Filtered") || text.includes("Route stations API") || text.includes("Selected vehicle")) {
      console.log('PAGE LOG:', text);
    }
  });
  
  await page.goto('http://127.0.0.1:5173/');
  
  await page.waitForTimeout(5000);
  
  const markers = await page.$$('.vehicle-marker');
  if (markers.length > 0) {
    console.log("Found", markers.length, "vehicles. Clicking the first one...");
    await markers[0].click();
    await page.waitForTimeout(3000);
    // Click on the map to deselect
    console.log("Deselecting...");
    await page.mouse.click(10, 10);
    await page.waitForTimeout(2000);
  } else {
    console.log("No vehicles found on screen!");
  }

  await browser.close();
})();

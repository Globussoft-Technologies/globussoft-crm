const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Navigate to the login page
  await page.goto('http://localhost:5174/login', { waitUntil: 'domcontentloaded' });
  
  // Click the Travel Stall quick login button
  await page.click('button:has-text("Travel Stall")');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  
  // Navigate to Curriculum Mappings
  await page.goto('http://localhost:5174/travel/curriculum-mappings', { waitUntil: 'networkidle' });
  
  // Wait for table to load
  await page.waitForSelector('table', { timeout: 5000 }).catch(() => {});
  
  // Take screenshot
  await page.screenshot({ path: 'C:\\Users\\Admin\\AppData\\Local\\Temp\\curriculum-mappings.png', fullPage: true });
  
  console.log('Screenshot saved');
  await browser.close();
})().catch(console.error);

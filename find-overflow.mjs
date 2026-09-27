import { chromium } from "playwright";

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost:3000/register", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1000);
  
  // Find all elements wider than viewport
  const wideElements = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 1440 && rect.width > 0) {
        results.push({
          tag: el.tagName,
          class: el.className,
          id: el.id,
          width: rect.width,
          height: rect.height,
          x: rect.x,
          right: rect.right
        });
      }
    });
    return results;
  });
  
  console.log("Wide elements (>1440px):", JSON.stringify(wideElements, null, 2));
  
  // Also check elements near the right edge
  const rightEdge = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right > 1440 && rect.width > 0) {
        results.push({
          tag: el.tagName,
          class: el.className,
          id: el.id,
          width: rect.width,
          x: rect.x,
          right: rect.right
        });
      }
    });
    return results;
  });
  
  console.log("Elements past right edge (>1440):", JSON.stringify(rightEdge, null, 2));
  
  await browser.close();
}

run().catch(console.error);

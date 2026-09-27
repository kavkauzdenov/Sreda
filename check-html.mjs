import { chromium } from "playwright";

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost:3000/register", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1000);
  
  // Check html element children for overflow
  const htmlChildren = await page.evaluate(() => {
    const html = document.documentElement;
    const results = [];
    for (const child of html.children) {
      const rect = child.getBoundingClientRect();
      if (rect.width > 0) {
        results.push({
          tag: child.tagName,
          class: child.className,
          id: child.id,
          width: rect.width,
          height: rect.height,
          x: rect.x,
          right: rect.right,
          scrollWidth: child.scrollWidth,
          clientWidth: child.clientWidth
        });
      }
    }
    return results;
  });
  
  console.log("HTML children:", JSON.stringify(htmlChildren, null, 2));
  
  // Check body children
  const bodyChildren = await page.evaluate(() => {
    const body = document.body;
    const results = [];
    for (const child of body.children) {
      const rect = child.getBoundingClientRect();
      if (rect.width > 0) {
        results.push({
          tag: child.tagName,
          class: child.className,
          id: child.id,
          width: rect.width,
          height: rect.height,
          x: rect.x,
          right: rect.right,
          scrollWidth: child.scrollWidth,
          clientWidth: child.clientWidth
        });
      }
    }
    return results;
  });
  
  console.log("Body children:", JSON.stringify(bodyChildren, null, 2));
  
  await browser.close();
}

run().catch(console.error);

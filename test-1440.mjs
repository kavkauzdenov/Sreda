import { chromium } from "playwright";

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost:3000/register", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "/tmp/register-1440.png", fullPage: true });
  
  const overflow = await page.evaluate(() => 
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 ||
    document.body.scrollWidth > document.documentElement.clientWidth + 1
  );
  
  console.log("Register 1440px: overflow=" + overflow);
  
  // Check account-story__art
  const artInfo = await page.evaluate(() => {
    const el = document.querySelector('.account-story__art');
    if (!el) return { found: false };
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return { 
      found: true, 
      width: rect.width, 
      height: rect.height,
      x: rect.x,
      y: rect.y,
      right: rect.right,
      maxWidth: style.maxWidth,
      width_css: style.width,
      margin: style.margin
    };
  });
  console.log("account-story__art:", JSON.stringify(artInfo, null, 2));
  
  // Check body overflow
  const bodyOverflow = await page.evaluate(() => {
    return {
      scrollWidth: document.body.scrollWidth,
      clientWidth: document.body.clientWidth,
      scrollWidth_html: document.documentElement.scrollWidth,
      clientWidth_html: document.documentElement.clientWidth
    };
  });
  console.log("Body overflow:", JSON.stringify(bodyOverflow, null, 2));
  
  await browser.close();
}

run().catch(console.error);

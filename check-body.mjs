import { chromium } from "playwright";

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost:3000/register", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1000);
  
  const bodyStyles = await page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    return {
      body: {
        margin: window.getComputedStyle(body).margin,
        padding: window.getComputedStyle(body).padding,
        width: window.getComputedStyle(body).width,
        maxWidth: window.getComputedStyle(body).maxWidth,
        overflow: window.getComputedStyle(body).overflow,
        overflowX: window.getComputedStyle(body).overflowX,
        scrollWidth: body.scrollWidth,
        clientWidth: body.clientWidth,
        offsetWidth: body.offsetWidth
      },
      html: {
        margin: window.getComputedStyle(html).margin,
        padding: window.getComputedStyle(html).padding,
        width: window.getComputedStyle(html).width,
        maxWidth: window.getComputedStyle(html).maxWidth,
        overflow: window.getComputedStyle(html).overflow,
        overflowX: window.getComputedStyle(html).overflowX,
        scrollWidth: html.scrollWidth,
        clientWidth: html.clientWidth,
        offsetWidth: html.offsetWidth
      }
    };
  });
  
  console.log("Body/HTML styles:", JSON.stringify(bodyStyles, null, 2));
  
  // Check for pseudo-elements
  const pseudo = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('*').forEach(el => {
      const style = window.getComputedStyle(el, '::before');
      const styleAfter = window.getComputedStyle(el, '::after');
      if (style.content !== 'none' || styleAfter.content !== 'none') {
        const rect = el.getBoundingClientRect();
        if (rect.right > 1440) {
          results.push({
            tag: el.tagName,
            class: el.className,
            before: { content: style.content, width: style.width, right: style.right },
            after: { content: styleAfter.content, width: styleAfter.width, right: styleAfter.right },
            rect: { right: rect.right, width: rect.width }
          });
        }
      }
    });
    return results;
  });
  
  console.log("Pseudo-elements past right edge:", JSON.stringify(pseudo, null, 2));
  
  await browser.close();
}

run().catch(console.error);

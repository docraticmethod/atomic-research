import puppeteer from 'puppeteer';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/pipeline-diagram.png');

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('http://localhost:4000/pipeline-diagram.html', { waitUntil: 'networkidle2' });

// Wait for Mermaid to render the SVG
await page.waitForSelector('.mermaid svg', { timeout: 15000 });

// Small settle pause for Mermaid layout to finalise
await new Promise(r => setTimeout(r, 500));

await page.screenshot({ path: OUT, fullPage: true });
await browser.close();

console.log(`Saved → ${OUT}`);

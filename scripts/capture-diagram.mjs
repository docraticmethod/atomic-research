import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/pipeline-diagram.png');

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto('http://localhost:4000/pipeline-diagram.html', { waitUntil: 'networkidle' });

// Wait for Mermaid to render the SVG
await page.waitForSelector('.mermaid svg', { timeout: 15000 });

// Small settle pause for Mermaid layout to finalise
await page.waitForTimeout(500);

await page.screenshot({ path: OUT, fullPage: true });
await browser.close();

console.log(`Saved → ${OUT}`);

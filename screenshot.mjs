// Usage: node screenshot.mjs <url> [label] [width] [--full]
// Saves to ./temporary screenshots/screenshot-N[-label].png (auto-incremented).
import { createRequire } from 'node:module';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const puppeteerDir = process.env.PUPPETEER_DIR || 'C:/Users/user/AppData/Local/Temp/puppeteer-test/';
const chromeDir = process.env.CHROME_PATH || 'C:/Users/user/.cache/puppeteer/chrome/win64-154.0.8037.57/chrome-win64/chrome.exe';
const require = createRequire(join(puppeteerDir, 'package.json'));
const puppeteer = require('puppeteer-core');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const full = process.argv.includes('--full');
const [url, label, widthArg] = args;
if (!url) {
  console.error('Usage: node screenshot.mjs <url> [label] [width] [--full]');
  process.exit(1);
}

const outDir = join(process.cwd(), 'temporary screenshots');
await mkdir(outDir, { recursive: true });
const used = (await readdir(outDir))
  .map((f) => /^screenshot-(\d+)/.exec(f)?.[1])
  .filter(Boolean)
  .map(Number);
const next = (used.length ? Math.max(...used) : 0) + 1;
const file = join(outDir, `screenshot-${next}${label ? `-${label}` : ''}.png`);

const browser = await puppeteer.launch({ executablePath: chromeDir, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(widthArg) || 1440, height: 900 });
  const problems = [];
  // Headless Chrome cannot reach external CDNs in this environment, but Node can,
  // so proxy non-local requests (Tailwind CDN, Google Fonts) through Node's fetch.
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const target = req.url();
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(target) || !/^https?:/.test(target)) {
      return req.continue();
    }
    try {
      let res;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await fetch(target, { headers: { 'User-Agent': await browser.userAgent() }, signal: AbortSignal.timeout(20000) });
          break;
        } catch (err) {
          if (attempt === 3) throw err;
        }
      }
      const headers = {};
      res.headers.forEach((v, k) => { if (['content-type', 'cache-control'].includes(k)) headers[k] = v; });
      await req.respond({ status: res.status, headers: { ...headers, 'access-control-allow-origin': '*' }, body: Buffer.from(await res.arrayBuffer()) });
    } catch (err) {
      problems.push(`proxy-fetch-failed: ${target} (${err.cause?.code || err.message})`);
      await req.abort();
    }
  });
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  // networkidle0 can hang on CDN keep-alive connections, so wait for load + fonts instead.
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  // Scroll through the page so lazy-loaded images load before capture, then return to top.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 350));
    }
    window.scrollTo(0, 0);
  });
  await new Promise((r) => setTimeout(r, 2500)); // let Tailwind compile and the hero entrance settle
  await page.screenshot({ path: file, fullPage: full });
  console.log(`Saved ${file}`);
  if (problems.length) console.log(problems.join('\n'));
} finally {
  await browser.close();
}

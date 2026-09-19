// usage: node test/shot.mjs out.png "query" [waitMs] [w] [h]
import { chromium } from 'playwright-core';
const [out = '/tmp/shot.png', q = '', waitMs = '3000', w = '1600', h = '1000'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5173/?lite=1&${q}`, { waitUntil: 'load' });
await page.waitForFunction(() => (window.__frames ?? 0) > 12, null, { timeout: 120000 });
await page.waitForTimeout(Number(waitMs));
const stats = await page.evaluate(() => { const s = window.sim; const snap = s.snapshot(); return { time: s.time, shipped: s.metrics.ordersShipped, backlog: snap.backlog, invariants: s.checkInvariants(), failed: s.metrics.jobsFailed }; });
await page.screenshot({ path: out });
console.log(JSON.stringify(stats));
for (const e of errors.slice(0, 10)) console.log(e);
await browser.close();

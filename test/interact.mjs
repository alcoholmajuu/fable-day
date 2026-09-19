import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('GL Driver')) errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/?lite=1&t=120', { waitUntil: 'load' });
await page.waitForFunction(() => (window.__frames ?? 0) > 10, null, { timeout: 120000 });
// click 4x and let it run
await page.click('[data-speed="4"]');
const t0 = await page.evaluate(() => window.sim.time);
await page.waitForTimeout(8000);
const t1 = await page.evaluate(() => window.sim.time);
console.log('sim advanced at 4x in 8s real:', (t1 - t0).toFixed(1), 's; frames:', await page.evaluate(() => window.__frames));
// select a worker via UI list
await page.click('[data-tab="workers"]');
await page.click('.w[data-sel^="worker:"]');
await page.waitForTimeout(500);
const inspText = await page.evaluate(() => document.querySelector('#inspector')?.textContent?.slice(0, 200));
console.log('inspector:', inspText);
// click on canvas center-ish to hit a rack
await page.click('[data-speed="0"]');
const sel = await page.evaluate(async () => { const c = document.getElementById('c'); const r = c.getBoundingClientRect(); return [r.width / 2, r.height / 2]; });
await page.mouse.click(sel[0], sel[1]);
await page.waitForTimeout(400);
console.log('after canvas click:', await page.evaluate(() => document.querySelector('#inspector')?.textContent?.slice(0, 120)));
console.log('invariants:', await page.evaluate(() => window.sim.checkInvariants()));
await page.screenshot({ path: '/tmp/s6.png' });
console.log('errors:', errors.slice(0, 8));
await browser.close();

/**
 * Headless smoke test + screenshots of the built app.
 *
 *   npm run build
 *   npx vite preview --port 4173 &
 *   npm i --no-save playwright-core          # not a project dependency
 *   CHROME=/path/to/chrome node scripts/screenshots.mjs [http://localhost:4173/]
 *
 * For every scenario it runs the simulation for a while, then checks that
 * there were no console/page errors, no NaNs, and that the canvas is not
 * blank, and writes PNGs to docs/. Exits non-zero on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const base = process.argv[2] ?? 'http://localhost:4173/';
const out = path.resolve(process.env.OUT_DIR ?? 'docs');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});
const failures = [];
const report = {};

async function openApp() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(base);
  await page.waitForFunction(() => window.galaxy?.globals != null, null, { timeout: 30000 });
  return { page, logs };
}

async function runUntil(page, myr, timeoutS = 600) {
  await page.waitForFunction((t) => (window.galaxy.globals?.timeMyr ?? 0) >= t, myr, { timeout: timeoutS * 1000, polling: 500 });
  await page.waitForTimeout(600); // let a fresh chart frame arrive
}

async function check(name, page, logs) {
  const st = await page.evaluate(() => {
    const c = document.getElementById('sim');
    const s = Math.min(c.width, c.height);
    const x0 = Math.round((c.width - s) / 2), y0 = Math.round((c.height - s) / 2);
    // copy into a scratch canvas so we never read back from the app's canvas
    const tmp = document.createElement('canvas');
    tmp.width = s;
    tmp.height = s;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(c, x0, y0, s, s, 0, 0, s, s);
    const img = tctx.getImageData(0, 0, s, s).data;
    let lit = 0, sum = 0, sum2 = 0, cnt = 0;
    for (let k = 0; k < img.length; k += 4 * 13) {
      const l = 0.2126 * img[k] + 0.7152 * img[k + 1] + 0.0722 * img[k + 2];
      if (l > 25) lit++;
      sum += l; sum2 += l * l; cnt++;
    }
    const mean = sum / cnt;
    return {
      litFraction: lit / cnt,
      lumStd: Math.sqrt(sum2 / cnt - mean * mean),
      nan: window.galaxy.nan,
      errors: window.galaxy.errors,
      globals: window.galaxy.globals,
      perf: window.galaxy.perf,
      fps: document.getElementById('fps').textContent,
    };
  });
  const problems = [];
  if (st.nan) problems.push('NaN in simulation');
  if (st.errors.length) problems.push(`worker errors: ${st.errors.join('; ')}`);
  if (logs.length) problems.push(`console: ${logs.join(' | ')}`);
  if (st.litFraction < 0.02 || st.lumStd < 5) problems.push(`canvas looks blank (lit ${st.litFraction.toFixed(3)}, std ${st.lumStd.toFixed(1)})`);
  if (!Number.isFinite(st.globals?.mass)) problems.push('non-finite diagnostics');
  report[name] = { ...st, problems };
  console.log(`${name}: t=${st.globals.timeMyr.toFixed(0)} Myr, ${st.fps}, ${st.perf.msPerStep.toFixed(1)} ms/step, ` +
    `${st.perf.myrPerSecond.toFixed(1)} Myr/s, lit=${st.litFraction.toFixed(2)}, <R>=${st.globals.meanRadius.toFixed(2)} kpc` +
    (problems.length ? `  PROBLEMS: ${problems.join('; ')}` : '  ok'));
  if (problems.length) failures.push(`${name}: ${problems.join('; ')}`);
}

const shot = (page, file) => page.screenshot({ path: path.join(out, file) });
const chartShot = (page, file) => page.locator('#chart-box').screenshot({ path: path.join(out, file) });

// 1. spiral with dark matter, then remove the halo live
{
  const { page, logs } = await openApp();
  await page.selectOption('#preset', 'spiral');
  await runUntil(page, 320);
  await check('spiral-dm', page, logs);
  await shot(page, 'spiral-dm.png');
  await chartShot(page, 'rotation-curve-dm.png');
  await page.keyboard.press('d'); // dark matter OFF, live
  await runUntil(page, 470);
  await check('spiral-dm-removed', page, logs);
  await shot(page, 'spiral-dm-removed.png');
  await chartShot(page, 'rotation-curve-dm-removed.png');
  await page.close();
}

// 2. spiral built without any dark matter (self-consistent, disk-dominated)
{
  const { page, logs } = await openApp();
  await page.selectOption('#preset', 'spiral');
  await page.click('#darkMatter');
  await page.click('#reset');
  await page.waitForTimeout(500);
  await runUntil(page, 320);
  await check('spiral-no-dm', page, logs);
  await shot(page, 'spiral-no-dm.png');
  await chartShot(page, 'rotation-curve-no-dm.png');
  await page.close();
}

// 3. elliptical (with halo), with the halo contours overlay
{
  const { page, logs } = await openApp();
  await page.selectOption('#preset', 'elliptical');
  await page.check('#contours');
  await runUntil(page, 200);
  await check('elliptical', page, logs);
  await shot(page, 'elliptical.png');
  await page.close();
}

// 4. barred spiral with velocity arrows
{
  const { page, logs } = await openApp();
  await page.selectOption('#preset', 'barred');
  await runUntil(page, 280);
  await page.check('#arrows');
  await page.waitForTimeout(800);
  await check('barred', page, logs);
  await shot(page, 'barred.png');
  await page.close();
}

// collage pages (rendered with the browser itself)
async function compose(file, cells, cols, cellW, cellH, crop) {
  const page = await browser.newPage({ viewport: { width: cols * cellW, height: Math.ceil(cells.length / cols) * (cellH + 28) }, deviceScaleFactor: 1 });
  const imgs = cells.map(([f, caption]) => {
    const data = fs.readFileSync(path.join(out, f)).toString('base64');
    const style = crop
      ? `width:${cellW}px;height:${cellH}px;object-fit:cover;object-position:${crop}`
      : `width:${cellW}px;height:${cellH}px;object-fit:contain`;
    return `<figure><img src="data:image/png;base64,${data}" style="${style}"><figcaption>${caption}</figcaption></figure>`;
  });
  await page.setContent(`<html><body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},${cellW}px)">
    <style>figure{margin:0}img{display:block}figcaption{height:28px;line-height:28px;color:#ddd;font:15px system-ui;text-align:center;background:#0b0d14}</style>
    ${imgs.join('')}</body></html>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, file), fullPage: true });
  await page.close();
}

await compose('rotation-curve.png', [
  ['rotation-curve-dm.png', 'with dark-matter halo: flat curve'],
  ['rotation-curve-dm-removed.png', '150 Myr after removing the halo'],
  ['rotation-curve-no-dm.png', 'galaxy built without dark matter'],
], 3, 350, 300);

await compose('collage.png', [
  ['spiral-dm.png', 'Spiral with dark matter (t ≈ 320 Myr)'],
  ['spiral-dm-removed.png', 'Same galaxy 150 Myr after the halo is switched off'],
  ['elliptical.png', 'Elliptical (pressure supported) in an NFW halo'],
  ['barred.png', 'Barred spiral with velocity arrows'],
], 2, 800, 450);

if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, JSON.stringify(report, null, 2));
await browser.close();
if (failures.length) {
  console.error('FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('all scenarios ok');

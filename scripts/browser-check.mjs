import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://127.0.0.1:4189/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

async function clickByText(text) {
  const handles = await page.$$('button');
  for (const b of handles) {
    const t = await page.evaluate((el) => el.textContent, b);
    if (t && t.includes(text)) { await b.click(); return true; }
  }
  return false;
}

try {
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('.stepper', { timeout: 10000 });
  await sleep(500);
  await page.screenshot({ path: 'diag/ui-1-capture.png' });
  console.log('step1 capture rendered');

  const clicked = await clickByText('模拟拍摄');
  if (!clicked) throw new Error('capture button not found');
  console.log('clicked capture, waiting for ring canvas...');

  await page.waitForSelector('#ring-canvas', { timeout: 120000 });
  // 等待 putImageData 完成
  await sleep(2500);
  await page.screenshot({ path: 'diag/ui-2-ring.png' });
  console.log('step2 ring rendered');

  const analyze = await clickByText('展开运行带并计算粗糙度');
  if (!analyze) throw new Error('analyze button not found');
  await page.waitForSelector('#rough-chart', { timeout: 120000 });
  await sleep(2000);
  await page.screenshot({ path: 'diag/ui-3-unroll.png', fullPage: true });
  console.log('step3 unroll + chart rendered');

  const cmp = await clickByText('查看历次对比');
  if (!cmp) throw new Error('compare nav button not found');
  await page.waitForSelector('#compare-chart', { timeout: 30000 });
  await page.waitForSelector('.seg-table tbody tr', { timeout: 30000 });
  await sleep(1500);
  await page.screenshot({ path: 'diag/ui-4-compare.png', fullPage: true });
  console.log('step4 compare + table rendered');

  const rows = await page.$$eval('.seg-table tbody tr', (trs) => trs.length);
  console.log('table rows =', rows);
} catch (e) {
  errors.push('HARNESS: ' + (e.stack || e.message));
  await page.screenshot({ path: 'diag/ui-error.png', fullPage: true }).catch(() => {});
}

console.log('\n==== BROWSER ERRORS (' + errors.length + ') ====');
console.log(errors.slice(0, 25).join('\n') || '(none)');
await browser.close();
process.exit(errors.some((e) => e.startsWith('pageerror') || e.startsWith('HARNESS')) ? 1 : 0);

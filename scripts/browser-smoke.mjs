import puppeteer from 'puppeteer-core'

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const browser = await puppeteer.launch({
  executablePath: edge,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0', timeout: 60000 })
await page.click('[data-action="run-both"]')
await page.waitForSelector('#ring-canvas', { timeout: 60000 })
await new Promise((resolve) => setTimeout(resolve, 1200))
await page.screenshot({ path: 'smoke-stitch.png', fullPage: false })

await page.click('[data-page="unwrap"]')
await page.waitForSelector('#band-canvas', { timeout: 10000 })
await page.waitForSelector('#roughness-curve', { timeout: 10000 })
await new Promise((resolve) => setTimeout(resolve, 700))
await page.screenshot({ path: 'smoke-unwrap.png', fullPage: false })

await page.click('[data-page="compare"]')
await page.waitForSelector('#compare-curve-canvas', { timeout: 10000 })
await page.waitForSelector('#direction-canvas', { timeout: 10000 })
await new Promise((resolve) => setTimeout(resolve, 800))
await page.screenshot({ path: 'smoke-compare.png', fullPage: false })

const summary = await page.evaluate(() => ({
  segmentTiles: document.querySelectorAll('.segment-tile').length,
  tableRows: document.querySelectorAll('tbody tr').length,
  kpis: Array.from(document.querySelectorAll('.kpi strong')).map((e) => e.textContent.trim()),
  notices: Array.from(document.querySelectorAll('.notice.good')).map((e) => e.textContent.trim()).slice(0, 2),
}))
console.log(JSON.stringify(summary, null, 2))
if (errors.length) {
  console.error(errors.join('\n'))
  await browser.close()
  process.exit(1)
}
await browser.close()
console.log('BROWSER_SMOKE_PASS')

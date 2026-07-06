// Render test: load the built HTML in headless Chromium with a CSP that
// blocks ALL external requests (mirrors the sandboxed-iframe constraint),
// verify no console errors and no network requests, take screenshots.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

(async () => {
  const file = path.resolve(process.argv[2] || 'casablanca-night-grid.html');
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    if (r.url() !== 'https://sandbox.test/index.html') requests.push(r.url());
  });

  // serve the raw HTML with a strict CSP via route interception
  const html = fs.readFileSync(file, 'utf8');
  await page.route('**/*', (route) => {
    if (route.request().url() === 'https://sandbox.test/index.html') {
      route.fulfill({
        contentType: 'text/html',
        headers: {
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;",
        },
        body: html,
      });
    } else {
      requests.push('BLOCKED: ' + route.request().url());
      route.abort();
    }
  });
  await page.goto('https://sandbox.test/index.html');

  // let it decode, build geometry, and render some frames
  await page.waitForTimeout(20000);

  const stats = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    nBld: document.getElementById('nBld').textContent,
    nRoad: document.getElementById('nRoad').textContent,
    title: document.title,
  }));
  await page.screenshot({ path: 'render_default.png' });

  // toggle checkboxes to prove they work
  await page.click('#cbBloom');
  await page.click('#cbScan');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'render_nobloom_noscan.png' });

  console.log('stats:', JSON.stringify(stats));
  console.log('non-inline requests:', requests.length ? requests : 'none');
  console.log('console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length || requests.length || !stats.canvases) process.exit(1);
  console.log('BROWSER TEST PASSED');
})();

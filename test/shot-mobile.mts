// Скриншоты мобильной раскладки (нужен установленный Chrome).
// Запуск: npx tsx test/shot-mobile.mts [outDir]  (dev-сервер поднимается сам)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5198;
const OUT = process.argv[2] ?? '/tmp/cup-holder-3d-shots-mobile';

async function waitForServer(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('dev server did not start');
}

async function run() {
  mkdirSync(OUT, { recursive: true });
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  });
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--use-angle=metal'],
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    // iPhone 14/15
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.startsWith('Готово'),
      { timeout: 30000 }
    );
    const shot = (name: string) => page.screenshot({ path: join(OUT, name) as `${string}.png` });

    await shot('m1-top.png');

    await page.evaluate(() => {
      document.getElementById('sidebar')!.scrollTo(0, 99999);
    });
    await new Promise((r) => setTimeout(r, 300));
    await shot('m2-panel-bottom.png');

    await browser.close();
    if (errors.length) {
      console.error('PAGE ERRORS:\n' + errors.join('\n'));
      process.exit(1);
    }
    console.log('shots →', OUT);
  } finally {
    vite.kill('SIGTERM');
  }
}

run().catch((e) => {
  console.error('SHOT FAILED:', e);
  process.exit(1);
});

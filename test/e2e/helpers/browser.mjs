// Real browser for the UI suites: playwright-core from this project or AFS_PLAYWRIGHT (path to a playwright-core
// folder). Returns {skipReason} when it is not available, so the suite is skipped with a notice instead of failing.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startServer, ROOT } from './harness.mjs';

async function loadPlaywright() {
  const norm = (m) => (m.chromium ? m : m.default);
  for (const c of [process.env.AFS_PLAYWRIGHT, path.join(ROOT, 'node_modules', 'playwright-core')].filter(Boolean)) {
    try { const req = createRequire(pathToFileURL(path.join(c, 'package.json'))); return norm(await import(pathToFileURL(req.resolve(c)).href)); } catch {}
  }
  try { return norm(await import('playwright-core')); } catch { return null; }
}

/** Starts an isolated server in dev mode (tests the client SOURCE) and a headless Chromium page. */
export async function openUi(name) {
  const pw = await loadPlaywright();
  if (!pw) return { skipReason: 'playwright-core no disponible (npm i -D playwright-core, o AFS_PLAYWRIGHT=<carpeta playwright-core>)' };
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) { return { skipReason: `Chromium no instalado: ${e.message.split('\n')[0]}` }; }
  const s = await startServer({ name, env: { NODE_ENV: 'development' } });
  await s.start();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'afs_ui', value: s.uiKey, url: s.base }]); // UI access key
  await ctx.addInitScript(() => { try { localStorage.setItem('afs.tourDone', '1'); localStorage.setItem('afs.autoOrder', '0'); } catch {} });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  /** Answers prompt/confirm dialogs in order (false = cancel, undefined = default value). */
  const answers = [];
  page.on('dialog', (d) => { const a = answers.shift(); if (a === false) d.dismiss(); else if (d.type() === 'prompt') d.accept(a ?? d.defaultValue()); else d.accept(); });
  return { s, browser, page, answers, close: async () => { await browser.close(); await s.stop(); } };
}

/** Screenshot + visible text into test-results/ when a UI test fails. */
export async function captureOnFailure(page, t) {
  if (!page || t.passed !== false) return;
  const dir = path.join(ROOT, 'test-results'); fs.mkdirSync(dir, { recursive: true });
  const name = t.name.replace(/[^\w]+/g, '_').slice(0, 60);
  try { await page.screenshot({ path: path.join(dir, `ui-${name}.png`), fullPage: true }); } catch {}
  try { fs.writeFileSync(path.join(dir, `ui-${name}.txt`), await page.locator('body').innerText()); } catch {}
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

// Exercise the real form, browser validation, bubbling events and saved drafts.
test('cash tray keeps counted cash, reconciliation and drafts consistent', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'petroleum-tray-'));
  let origin;
  const server = spawn(process.env.PYTHON || 'python3', [
    '-u', 'app.py', '--port', '0', '--db', path.join(directory, 'test.sqlite3'),
  ], { cwd: path.join(__dirname, '..'), env: { ...process.env,
    RENDER: '', PETROLEUM_HOSTED: '', TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '',
  }, stdio: 'pipe' });
  let logs = '';
  server.stdout.on('data', chunk => {
    logs += chunk;
    origin = logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  });
  server.stderr.on('data', chunk => { logs += chunk; });
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { ready = Boolean(origin) && (await fetch(origin + '/healthz')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(origin + '/manager');
  await page.getByRole('button', { name: 'Fill demo sign-in' }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('[name^="opening_"]').first().waitFor();
  for (const input of await page.locator('[name^="opening_"]').all()) await input.fill('0');
  await page.getByRole('button', { name: 'Open shift', exact: true }).click();
  const counted = page.locator('[name="counted"]');
  await counted.waitFor();
  const notes = page.locator('[data-denom="500"]');
  const total = page.locator('#denom-total');
  const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem('tuljai_draft_1')));
  const openTray = () => page.getByRole('button', { name: 'Open Tray', exact: true }).click();
  await openTray();

  await t.test('reducing a positive total to zero updates cash and draft', async () => {
    await notes.fill('2');
    assert.equal(await counted.inputValue(), '1000.00');
    await notes.fill('0');
    assert.equal(await counted.inputValue(), '0.00');
    assert.equal((await draft()).fields.counted, '0.00');
    assert.match(await page.locator('#counted').textContent(), /0\.00/);
  });

  await t.test('invalid counts never overwrite counted cash', async () => {
    for (const invalid of ['-1', '1.5', '100001']) {
      await counted.fill('42');
      await notes.fill(invalid);
      assert.equal(await counted.inputValue(), '42');
      assert.equal(await total.textContent(), '—');
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      assert.equal(await counted.inputValue(), '42');
    }
    await notes.fill('2');
  });

  await t.test('reload restores tray totals without overwriting manual counted cash', async () => {
    await counted.fill('925');
    await page.reload();
    await counted.waitFor();
    assert.equal(await counted.inputValue(), '925');
    assert.match(await total.textContent(), /1,000\.00/);
    await openTray();
  });

  await t.test('Apply and Clear persist their changes immediately', async () => {
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    assert.equal((await draft()).fields.counted, '1000.00');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    assert.equal(await counted.inputValue(), '');
    assert.equal((await draft()).fields.counted, '');
    assert.deepEqual((await draft()).denoms, {});
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    assert.equal(await counted.inputValue(), '0.00');
    assert.equal((await draft()).fields.counted, '0.00');
    await page.reload();
    await counted.waitFor();
    assert.equal(await counted.inputValue(), '0.00');
  });
});

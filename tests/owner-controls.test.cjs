const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

test('owner controls work through desktop and mobile screens', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'petroleum-owner-'));
  let origin, browser, logs = '';
  const server = spawn(process.env.PYTHON || 'python3', ['-u','app.py','--port','0','--db',path.join(directory,'test.sqlite3')], {
    cwd:path.join(__dirname,'..'), env:{...process.env, RENDER:'', PETROLEUM_HOSTED:'', TURSO_DATABASE_URL:'', TURSO_AUTH_TOKEN:''}, stdio:'pipe',
  });
  server.stdout.on('data', chunk => { logs += chunk; origin = logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; });
  server.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit',resolve));
    await rm(directory,{recursive:true,force:true});
  });
  for (let i=0; i<100 && !origin; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.ok(origin, logs);
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  const post = async (route, body) => {
    const result = await context.request.post(origin + '/api/' + route, {data:body});
    assert.equal(result.status(),200,await result.text());
    return result.json();
  };
  await post('manager/login',{email:'manager@demo.local',password:'ManagerDemo123!'});
  await post('manager/shift',{openings:{1:100,2:200}});
  await page.goto(origin + '/owner');
  await page.getByRole('button',{name:'Fill demo sign-in'}).click();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'View operations',exact:true}).click();
  await page.getByRole('heading',{name:'Current open shift'}).waitFor();
  assert.match(await page.locator('main').textContent(),/Asha Patil/);
  const tank = page.locator('#tank-Petrol');
  await tank.getByLabel('Usable capacity (L)').fill('10000');
  await tank.getByLabel('Low stock warning at or below (L)').fill('8000');
  await tank.getByRole('button',{name:'Save Petrol tank'}).click();
  await page.getByRole('heading',{name:'Operations',exact:true}).waitFor();
  await post('manager/shifts/1/submit',{closings:{1:110,2:210},collections:{cash:100,upi:200,card:300},expenses:10,counted:90,
    entries:{payments:[{method:'credit',amount:400,party:'Fleet A',reference:'INV-1'}]}});

  // A correction request is answered by the manager, applied by the owner, and audited.
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Open shift 1 report'}).click();
  await page.locator('#request-correction').getByLabel('Ask the manager to clarify or correct').fill('Confirm counted cash');
  await page.getByRole('button',{name:'Send correction request'}).click();
  await page.getByText('Confirm counted cash',{exact:false}).first().waitFor();
  const manager = await context.newPage();
  manager.setDefaultTimeout(7000);
  await manager.goto(origin + '/manager');
  await manager.getByRole('button',{name:'Owner requests',exact:true}).click();
  await manager.getByLabel('Correct figures / explanation').fill('Counted cash is 100 after recount');
  await manager.getByRole('button',{name:'Send response',exact:true}).click();
  await manager.getByText('Counted cash is 100 after recount',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Correct report figures'}).click();
  await page.getByLabel('Reason for correcting this report').fill('Confirmed recount with manager');
  await page.getByLabel('Actual cash counted (₹)',{exact:true}).fill('100');
  await page.getByRole('button',{name:'Save report correction'}).click();
  await page.getByText('Confirmed recount with manager',{exact:false}).waitFor({state:'attached'});
  assert.match(await page.locator('main').textContent(),/Correction by/);
  await page.getByRole('button',{name:'Operations',exact:true}).click();
  const request = page.locator('details.business-record').filter({hasText:'Confirm counted cash'});
  await request.locator('summary').click();
  await request.getByLabel('Resolution / adjustment made').fill('Corrected cash after recount');
  await request.getByRole('button',{name:'Close request',exact:true}).click();
  await page.getByText('Shift #1 · Closed',{exact:false}).waitFor();

  await post('manager/shift',{openings:{}});
  await post('manager/shifts/2/submit',{closings:{1:111,2:211},collections:{credit:50},counted:0});
  await page.getByRole('button',{name:'Money',exact:true}).click();
  const allocation = page.locator('#allocate-2');
  await allocation.locator('..').locator('summary').click();
  await allocation.getByLabel('Customer / account name').fill('Fleet B');
  await allocation.getByLabel('Credit amount to assign (₹)').fill('50');
  await allocation.getByLabel('Unique allocation reference').fill('ALLOC-1');
  await allocation.getByRole('button',{name:'Assign credit to customer'}).click();
  await page.getByText('Fleet B · ₹50.00 outstanding',{exact:false}).waitFor();
  const config = page.locator('#customer-config');
  await config.locator('..').locator('summary').click();
  await config.getByLabel('Customer / account name').fill('Fleet A');
  await config.getByLabel('Account payment due date (optional)').fill('2026-11-21');
  await config.getByRole('button',{name:'Save customer'}).click();
  await page.getByText('Fleet A · ₹400.00 outstanding · Overdue',{exact:false}).waitFor();
  const customer = page.locator('details.business-record').filter({has:page.locator('summary',{hasText:'Fleet A'})});
  await customer.locator('summary').click();
  await customer.getByLabel('Amount received (₹)').fill('100');
  await customer.getByLabel('Unique receipt / bank reference').fill('RCPT-1');
  await customer.getByRole('button',{name:'Record repayment'}).click();
  await page.getByText('Fleet A · ₹300.00 outstanding',{exact:false}).waitFor();
  const card = page.locator('.settlement-record').filter({has:page.locator('summary',{hasText:'· Card ·'})});
  await card.locator('summary').click();
  await card.getByLabel('Net bank receipt (₹)').fill('195');
  await card.getByLabel('Settlement fees (₹)').fill('5');
  await card.getByLabel('Unique bank / deposit reference').fill('BANK-1');
  await card.getByRole('button',{name:'Record settlement'}).click();
  await page.getByText('Card · ₹100.00 pending',{exact:false}).waitFor();
  const cash = page.locator('.settlement-record').filter({has:page.locator('summary',{hasText:'· Cash ·'})});
  await cash.locator('summary').click();
  await cash.getByLabel('Cash deposited (₹)').fill('100');
  await cash.getByLabel('Unique bank / deposit reference').fill('DEPOSIT-1');
  await cash.getByRole('button',{name:'Record deposit'}).click();
  await page.getByText('Cash · ₹0.00 pending',{exact:false}).waitFor({state:'attached'});
  await page.locator('#settlement-filter').selectOption('all');
  await page.getByText('Cash · ₹0.00 pending',{exact:false}).waitFor();

  await page.getByRole('button',{name:'Exceptions',exact:true}).click();
  const exception = page.locator('.exception-record').first();
  await exception.locator('summary').click();
  await exception.getByLabel('Follow-up / action taken').fill('Investigating with manager');
  await exception.getByRole('button',{name:'Acknowledge',exact:true}).click();
  await page.locator('#exception-filter').waitFor();
  await page.locator('#exception-filter').selectOption('all');
  await page.getByText('Investigating with manager',{exact:false}).waitFor({state:'attached'});

  await page.getByRole('button',{name:'Team',exact:true}).click();
  const account = page.locator('.business-record').filter({has:page.locator('summary',{hasText:'Asha Patil'})});
  await account.locator('summary').click();
  await account.getByRole('button',{name:'Deactivate manager',exact:true}).click();
  await page.getByText('Asha Patil · manager@demo.local · Inactive',{exact:false}).waitFor();
  assert.equal((await context.request.get(origin + '/api/manager/shift')).status(),401);

  await page.setViewportSize({width:390,height:844});
  for (const nav of ['Overview','Money','Operations','Exceptions','Team']) {
    await page.getByRole('button',{name:nav,exact:true}).click();
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => ({ width:innerWidth, scroll:document.documentElement.scrollWidth, elements:[...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0,8).map(el => el.tagName + '.' + el.className) }));
    assert.ok(overflow.scroll <= overflow.width + 1, nav + ' overflows: ' + JSON.stringify(overflow));
  }
  if (process.env.OWNER_SCREENSHOT_DIR) {
    await mkdir(process.env.OWNER_SCREENSHOT_DIR,{recursive:true});
    await page.getByRole('button',{name:'Money',exact:true}).click();
    await page.getByRole('heading',{name:'Money',exact:true}).waitFor();
    await page.screenshot({path:path.join(process.env.OWNER_SCREENSHOT_DIR,'owner-money-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:path.join(process.env.OWNER_SCREENSHOT_DIR,'owner-money-desktop.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);
});

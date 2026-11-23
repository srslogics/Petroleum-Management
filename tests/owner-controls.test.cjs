const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

test('owner controls work through desktop and mobile screens', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'petroleum-owner-'));
  let origin, browser, logs = '', completed = false;
  const server = spawn(process.env.PYTHON || 'python3', ['-u','app.py','--port','0','--db',path.join(directory,'test.sqlite3')], {
    cwd:path.join(__dirname,'..'), env:{...process.env, RENDER:'', PETROLEUM_HOSTED:'', TURSO_DATABASE_URL:'', TURSO_AUTH_TOKEN:''}, stdio:'pipe',
  });
  server.stdout.on('data', chunk => { logs += chunk; origin = logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; });
  server.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (browser) {
      if (!completed) console.log('OWNER WORKFLOW STATE',JSON.stringify({pages:await Promise.all(browser.contexts().flatMap(context=>context.pages()).map(async tab=>({url:tab.url(),body:(await tab.locator('body').innerText()).slice(0,2200)}))),logs}));
      await browser.close();
    }
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
  page.setDefaultTimeout(15000);
  const errors = [];
  context.on('page', tab => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('requestfailed', request => {if (['script','stylesheet','font'].includes(request.resourceType())) errors.push(request.url() + ': ' + request.failure()?.errorText);});
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => {if (['script','stylesheet','font'].includes(request.resourceType())) errors.push(request.url() + ': ' + request.failure()?.errorText);});
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
  await page.getByRole('button',{name:'WhatsApp',exact:true}).click();
  const compose = page.getByRole('dialog',{name:'Send with WhatsApp'});
  await compose.getByLabel('WhatsApp number (optional)').fill('9000000002');
  await compose.getByRole('button',{name:'Open WhatsApp'}).click();
  await compose.getByText('Enter a mobile number starting with + and its country code.').waitFor();
  await compose.getByLabel('WhatsApp number (optional)').fill('+91 90000-00002');
  await compose.getByLabel('Message',{exact:true}).fill('Hello & welcome!');
  await context.route('https://wa.me/**', route => route.fulfill({body:'WhatsApp test page'}));
  const popupEvent = page.waitForEvent('popup');
  await compose.getByRole('button',{name:'Open WhatsApp'}).click();
  const popup = await popupEvent;
  const destination = new URL(popup.url());
  assert.equal(destination.origin + destination.pathname, 'https://wa.me/919000000002');
  assert.equal(destination.searchParams.get('text'), 'Hello & welcome!');
  await popup.close();
  await compose.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('button',{name:'View operations',exact:true}).click();
  await page.getByRole('heading',{name:'Current open shift'}).waitFor();
  assert.match(await page.locator('main').textContent(),/Asha Patil/);
  const tank = page.locator('#tank-Petrol');
  await tank.getByLabel('Usable capacity (L)').fill('10000');
  await tank.getByLabel('Low stock warning at or below (L)').fill('8000');
  await tank.getByRole('button',{name:'Save Petrol tank'}).click();
  await page.getByRole('heading',{name:'Operations',exact:true}).waitFor();
  await post('owner/shifts/1/submit',{closings:{1:110,2:210},collections:{cash:100,upi:200,card:300},expenses:10,counted:90,
    entries:{payments:[{method:'credit',amount:400,party:'Fleet A',reference:'INV-1'}]}});

  // A correction request is answered by the manager, applied by the owner, and audited.
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Open shift 1 report'}).click();
  await page.locator('#request-correction').getByLabel('Ask the manager to clarify or correct').fill('Confirm counted cash');
  await page.getByRole('button',{name:'Send correction request'}).click();
  await page.getByText('Confirm counted cash',{exact:false}).first().waitFor();
  const manager = await context.newPage();
  manager.setDefaultTimeout(15000);
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
  await post('owner/shifts/2/submit',{closings:{1:111,2:211},collections:{credit:50},counted:0});
  await page.getByRole('button',{name:'Money',exact:true}).click();
  await page.getByRole('button',{name:'Assign credit',exact:false}).click();
  const allocation = page.getByRole('dialog');
  await allocation.getByLabel('Customer / account name').fill('Fleet B');
  await allocation.getByLabel('Credit amount to assign (₹)').fill('50');
  await allocation.getByLabel('Unique allocation reference').fill('ALLOC-1');
  await allocation.getByRole('button',{name:'Assign credit',exact:true}).click();
  await page.getByRole('button',{name:'Open account for Fleet B',exact:true}).waitFor();
  await page.getByRole('button',{name:'Open account for Fleet A',exact:true}).click();
  await page.getByRole('button',{name:'Set due date',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Payment due date (optional)').fill('2026-11-21');
  await page.getByRole('dialog').getByRole('button',{name:'Save customer',exact:true}).click();
  const customer = page.getByRole('row').filter({has:page.getByRole('button',{name:'Open account for Fleet A',exact:true})});
  await customer.getByText('Overdue',{exact:true}).waitFor();
  await customer.getByRole('button',{name:'Record payment',exact:true}).click();
  const payment = page.getByRole('dialog');
  await payment.getByLabel('Amount received (₹)').fill('100');
  await payment.getByLabel('Unique receipt reference').fill('RCPT-1');
  await payment.getByRole('button',{name:'Record payment',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.match(await customer.locator('td').nth(3).textContent(),/300.00/);
  // A duplicate bank/receipt reference must keep the form open and its inputs intact.
  await customer.getByRole('button',{name:'Record payment',exact:true}).click();
  await payment.getByLabel('Amount received (₹)').fill('100');
  await payment.getByLabel('Unique receipt reference').fill('RCPT-1');
  await payment.getByRole('button',{name:'Record payment',exact:true}).click();
  await payment.getByText('This reference has already been recorded. Refresh before trying again.',{exact:true}).waitFor();
  assert.equal(await payment.getByLabel('Amount received (₹)').inputValue(),'100');
  await payment.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('tab',{name:/^Banking/}).click();
  const card = page.getByRole('row').filter({has:page.getByText('Card',{exact:true})});
  await card.getByRole('button',{name:'Record settlement',exact:true}).click();
  const receipt = page.getByRole('dialog');
  await receipt.getByLabel('Net bank receipt (₹)').fill('195');
  await receipt.getByLabel('Settlement fees (₹)').fill('5');
  await receipt.getByLabel('Unique bank / deposit reference').fill('BANK-1');
  await receipt.getByRole('button',{name:'Record settlement',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.match(await card.locator('td').nth(4).textContent(),/100.00/);
  const cash = page.getByRole('row').filter({has:page.getByText('Cash',{exact:true})});
  await cash.getByRole('button',{name:'Record deposit',exact:true}).click();
  await receipt.getByLabel('Cash deposited (₹)').fill('100');
  await receipt.getByLabel('Unique bank / deposit reference').fill('DEPOSIT-1');
  await receipt.getByRole('button',{name:'Record deposit',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByLabel('Banking status').selectOption('all');
  assert.match(await cash.locator('td').nth(4).textContent(),/0.00/);
  await page.getByRole('tab',{name:/^Customers/}).click();
  await page.getByLabel('Search customers',{exact:true}).fill('Fleet B');
  await page.getByRole('button',{name:'Open account for Fleet B',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Open account for Fleet A',exact:true}).isVisible(),false);
  await page.getByLabel('Search customers',{exact:true}).fill('');
  await page.getByRole('button',{name:'Open account for Fleet A',exact:true}).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button',{name:'Export statement',exact:true}).click();
  assert.match((await downloadEvent).suggestedFilename(),/^customer-statement-/);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();

  await page.getByRole('button',{name:'Exceptions',exact:true}).click();
  const exception = page.locator('.exception-record').first();
  await exception.locator('summary').click();
  await exception.getByLabel('Follow-up / action taken').fill('Investigating with manager');
  await exception.getByRole('button',{name:'Acknowledge',exact:true}).click();
  await page.locator('#exception-filter').waitFor();
  await page.locator('#exception-filter').selectOption('all');
  await page.getByText('Investigating with manager',{exact:false}).waitFor({state:'attached'});

  await page.getByRole('button',{name:'Automation',exact:true}).click();
  await page.getByRole('tab',{name:'Alerts',exact:true}).click();
  const fleetReminder = page.getByRole('row').filter({hasText:'Fleet B'});
  await fleetReminder.getByRole('button',{name:'Open reminder',exact:true}).click();
  const reminder = page.getByRole('dialog',{name:'Payment reminder'});
  const reminderText = await reminder.locator('#auto-reminder-text').inputValue();
  const reminderUrl = new URL(await reminder.getByRole('link',{name:'Open WhatsApp',exact:true}).getAttribute('href'));
  assert.equal(reminderUrl.origin + reminderUrl.pathname, 'https://wa.me/');
  assert.equal(reminderUrl.searchParams.get('text'), reminderText);
  await reminder.getByRole('button',{name:'Close dialog'}).click();

  await post('owner/managers',{name:'Mobile Manager',phone:'+91 90000-00002',password:'ManagerTestPassword123!'});
  await page.getByRole('button',{name:'Team',exact:true}).click();
  await page.locator('summary').filter({hasText:'Mobile Manager'}).click();
  assert.equal(await page.getByRole('link',{name:'WhatsApp Mobile Manager',exact:true}).getAttribute('href'), 'https://wa.me/919000000002');
  const account = page.locator('.business-record').filter({has:page.locator('summary',{hasText:'Asha Patil'})});
  await account.locator('summary').click();
  await account.getByRole('button',{name:'Deactivate manager',exact:true}).click();
  await page.getByText('Asha Patil · manager@demo.local · Inactive',{exact:false}).waitFor();
  assert.equal((await context.request.get(origin + '/api/manager/shift')).status(),401);

  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Account activity',exact:true}).click();
  const accountAudit = page.getByRole('dialog',{name:'Account activity'});
  await accountAudit.getByText('Account disabled',{exact:true}).waitFor();
  await accountAudit.getByRole('button',{name:'Close dialog'}).click();

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
  // The install action and navigation must survive signing out and back in.
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:'Fill demo sign-in'}).click();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Station overview'}).waitFor();
  assert.equal(await page.locator('#install-app').count(),1);
  await page.getByRole('button',{name:'Operations',exact:true}).click();
  await page.getByRole('heading',{name:'Operations',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  completed = true;
});

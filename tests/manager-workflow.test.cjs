const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtemp,rm,mkdir,readFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');

test('Manager entry drafts, simple totals, cash counter and final submission work on phones and desktop',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'petroleum-outgoing-'));
  let origin,browser,logs='';
  const server=spawn(process.env.PYTHON||'python3',['-u','app.py','--port','0','--db',path.join(dir,'test.sqlite3')],{cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',PETROLEUM_HOSTED:'',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:''},stdio:'pipe'});
  server.stdout.on('data',chunk=>{logs+=chunk;origin=logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];});server.stderr.on('data',chunk=>{logs+=chunk;});
  t.after(async()=>{if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));await rm(dir,{recursive:true,force:true});});
  for(let i=0;i<100&&!origin;i++){if(server.exitCode!==null)throw Error(logs);await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(origin,logs);
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>{if(['script','stylesheet','font'].includes(r.resourceType()))errors.push(r.url());});
  const login=await context.request.post(origin+'/api/manager/login',{data:{email:'manager@demo.local',password:'ManagerDemo123!'}});assert.equal(login.status(),200);
  await page.goto(origin+'/manager');await page.getByRole('button',{name:'Open shift',exact:true}).waitFor();
  const opening=page.getByLabel('Opening reading (L)',{exact:true});await opening.nth(0).fill('100');await opening.nth(1).fill('200');await page.getByRole('button',{name:'Open shift',exact:true}).click();
  await page.getByRole('heading',{name:'Shift entries',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Credit (₹)',{exact:true}).count(),0);assert.equal(await page.getByLabel('Customer / account',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Review entries',exact:true}).click();assert.equal(await page.getByLabel('P-01 closing reading (L)').evaluate(el=>el===document.activeElement),true);
  await page.getByLabel('P-01 closing reading (L)').fill('110');await page.getByLabel('D-01 closing reading (L)').fill('210');await page.getByLabel('Petrol physical stock (L)').fill('8000');
  await page.getByRole('button',{name:'Collections',exact:true}).click();await page.getByLabel('Cash collected (₹)',{exact:true}).fill('500');await page.getByLabel('UPI collected (₹)').fill('1000');await page.getByLabel('Card collected (₹)').fill('468');
  await page.getByRole('button',{name:'Count cash by denomination',exact:true}).click();const cash=page.locator('#manager-cash-dialog');await cash.getByLabel('₹200 × quantity',{exact:true}).fill('2');await cash.getByLabel('₹50 × quantity',{exact:true}).fill('1');await cash.getByRole('button',{name:'Use counted total',exact:true}).click();assert.equal(await page.getByLabel('Actual cash counted (₹)',{exact:true}).inputValue(),'450.00');
  await page.getByText('Payment batch references (optional)',{exact:true}).click();let batches=page.locator('[data-entry-list="payments"]').locator('..');await batches.getByRole('button',{name:'Add entry',exact:true}).click();await batches.getByLabel('Payment method').selectOption('upi');await batches.getByLabel('Amount (₹)',{exact:true}).fill('1000');await batches.getByLabel('Receipt / transaction reference',{exact:true}).fill('UTR-1');assert.equal(await batches.getByLabel('Payment method').locator('option').count(),3);assert.equal(await page.getByLabel('Cash collected (₹)',{exact:true}).inputValue(),'500');assert.equal(await page.getByLabel('UPI collected (₹)').getAttribute('readonly'),'');
  await page.getByRole('button',{name:'Deliveries',exact:true}).click();await page.getByText('Supplier and challan details (optional)',{exact:true}).click();let section=page.locator('[data-entry-list="deliveries"]').locator('..');await section.getByRole('button',{name:'Add entry',exact:true}).click();await section.getByLabel('Quantity (L)',{exact:true}).fill('100');await section.getByLabel('Supplier / tanker',{exact:true}).fill('Fuel Supplier');await section.getByLabel('Invoice / challan number',{exact:true}).fill('CH-1');
  await page.getByRole('button',{name:'Expenses',exact:true}).click();await page.getByText('Individual expenses (optional)',{exact:true}).click();section=page.locator('[data-entry-list="expenses"]').locator('..');await section.getByRole('button',{name:'Add entry',exact:true}).click();await section.getByLabel('Amount (₹)',{exact:true}).fill('50');await section.getByLabel('Paid to',{exact:true}).fill('Cleaner');await section.getByLabel('Expense description',{exact:true}).fill('Cleaning');await page.getByLabel('Shift note (optional)',{exact:true}).fill('Check hose');
  await page.getByRole('button',{name:'Save now',exact:true}).click();await page.locator('#manager-save-status').getByText(/^Saved /).waitFor();
  page.on('dialog',d=>d.accept());await page.reload();await page.getByRole('heading',{name:'Shift entries',exact:true}).waitFor();assert.equal(await page.getByLabel('P-01 closing reading (L)').inputValue(),'110');await page.getByRole('button',{name:'Expenses',exact:true}).click();assert.equal(await page.getByLabel('Expense description',{exact:true}).inputValue(),'Cleaning');assert.equal(await page.getByLabel('Shift note (optional)',{exact:true}).inputValue(),'Check hose');
  // Offline edits survive a same-tab refresh/navigation, and reconnect saves them.
  await context.setOffline(true);await page.getByLabel('Shift note (optional)',{exact:true}).fill('Offline note');await page.getByRole('button',{name:'Save now',exact:true}).click();await page.locator('#manager-save-status').getByText(/Not saved online/).waitFor();await context.setOffline(false);await page.getByRole('button',{name:'Save now',exact:true}).click();await page.locator('#manager-save-status').getByText(/^Saved /).waitFor();
  await page.route('**/api/manager/shifts/1/draft',route=>route.request().method()==='POST'?route.abort():route.continue());await page.getByLabel('Shift note (optional)',{exact:true}).fill('Local unsaved note');await page.getByRole('button',{name:'Save now',exact:true}).click();await page.locator('#manager-save-status').getByText(/Not saved online/).waitFor();await page.reload();await page.getByRole('heading',{name:'Shift entries',exact:true}).waitFor();await page.getByRole('button',{name:'Expenses',exact:true}).click();assert.equal(await page.getByLabel('Shift note (optional)',{exact:true}).inputValue(),'Local unsaved note');await page.unroute('**/api/manager/shifts/1/draft');await page.getByRole('button',{name:'Save now',exact:true}).click();await page.locator('#manager-save-status').getByText(/^Saved /).waitFor();
  // A second editor is detected before stale data is submitted.
  const other=await context.newPage();other.on('dialog',d=>d.accept());await other.goto(origin+'/manager');await other.getByRole('heading',{name:'Shift entries',exact:true}).waitFor();
  await page.getByLabel('Shift note (optional)',{exact:true}).fill('First tab note');await page.getByRole('button',{name:'Save now',exact:true}).click();await page.locator('#manager-save-status').getByText(/^Saved /).waitFor();
  await other.getByRole('button',{name:'Expenses',exact:true}).click();await other.getByLabel('Shift note (optional)',{exact:true}).fill('Second tab note');await other.getByRole('button',{name:'Save now',exact:true}).click();await other.locator('#manager-save-status').getByText(/Draft changed elsewhere/).waitFor();await other.getByRole('button',{name:'Load saved draft',exact:true}).click();await other.getByRole('dialog').getByRole('button',{name:'Load saved draft',exact:true}).click();await other.getByRole('button',{name:'Expenses',exact:true}).click();assert.equal(await other.getByLabel('Shift note (optional)',{exact:true}).inputValue(),'First tab note');await other.close();
  const capture=process.env.SCREENSHOT_DIR;if(capture)await mkdir(capture,{recursive:true});
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});for(const tab of ['Meters & stock','Collections','Deliveries','Expenses']){await page.getByRole('button',{name:tab,exact:true}).click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),tab+' at '+width);}if(capture)await page.screenshot({path:path.join(capture,'manager-'+width+'.png'),fullPage:true});}
  // The owner has an independent session and can keep the report open while the manager works.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerErrors = [];
  owner.on('pageerror', error => ownerErrors.push(error.message));
  const ownerLogin = await ownerContext.request.post(origin + '/api/owner/login', {
    data: {email:'owner@demo.local', password:'OwnerDemo123!'},
  });
  assert.equal(ownerLogin.status(), 200);
  await owner.goto(origin + '/owner');
  await owner.getByRole('button', {name:'Daily report', exact:true}).click();
  await owner.getByText('No shifts were submitted for this business date.').waitFor();
  await page.getByRole('button',{name:'Review entries',exact:true}).click();const review=page.locator('#money-dialog');await review.getByRole('heading',{name:'Review shift entries',exact:true}).waitFor();await review.getByText('CH-1',{exact:false}).waitFor();await review.getByRole('button',{name:'Back to entries',exact:true}).click();assert.equal(await page.getByLabel('Shift note (optional)',{exact:true}).inputValue(),'First tab note');
  await page.getByRole('button',{name:'Review entries',exact:true}).click();if(capture)await page.screenshot({path:path.join(capture,'manager-review-320.png'),fullPage:true});await page.route('**/api/manager/shifts/1/submit',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary test failure. Try again.'})}));await review.getByRole('button',{name:'Submit shift closing',exact:true}).click();await review.locator('.form-error').getByText(/Temporary test failure/).waitFor();assert.equal(await page.getByLabel('Shift note (optional)',{exact:true}).inputValue(),'First tab note');await page.unroute('**/api/manager/shifts/1/submit');await review.getByRole('button',{name:'Submit shift closing',exact:true}).click();await page.getByRole('heading',{name:'Open a shift',exact:true}).waitFor();assert.match(await page.locator('main').textContent(),/Shift #1 submitted/);
  const shift = await (await ownerContext.request.get(origin + '/api/owner/shifts/1')).json();
  assert.deepEqual(shift.collections, {cash:50000, upi:100000, card:46800, credit:0});
  assert.equal(shift.counted, 45000);
  assert.equal(shift.expenses, 5000);
  assert.equal(shift.entries.deliveries[0].reference, 'CH-1');
  assert.equal(shift.shift_note, 'First tab note');
  assert.equal(shift.cash_difference, 0);

  await owner.getByRole('button', {name:'Refresh report'}).click();
  await owner.getByRole('button', {name:'Shift #1', exact:true}).waitFor();
  const daily = await (await ownerContext.request.get(origin + '/api/owner/daily-report?date=' + shift.business_date)).json();
  assert.equal(daily.sales, 196800);
  assert.equal(daily.litres, 20000);
  assert.deepEqual(daily.payments, shift.collections);
  assert.deepEqual(daily.till, {expenses:5000, expected:45000, counted:45000, cash_difference:0, shortage:0, overage:0});
  assert.equal(daily.fuels.Petrol.closing_stock, daily.fuels.Petrol.opening_stock + 90000);
  assert.equal(daily.fuels.Petrol.physical.litres, 8000000);
  assert.deepEqual(daily.shifts[0].entries, shift.entries);
  await owner.getByRole('button', {name:'Share via WhatsApp'}).click();
  const share = owner.getByRole('dialog', {name:'Send with WhatsApp'});
  const message = await share.getByLabel('Message', {exact:true}).inputValue();
  assert.match(message, /Metered fuel sales: ₹1,968\.00 · 20 L/);
  assert.match(message, /Cash counted: ₹450\.00 · Cash difference: ₹0\.00/);
  assert.ok(!message.includes('First tab note'));
  await share.getByRole('button', {name:'Close dialog'}).click();

  await owner.getByRole('button', {name:'Shift #1', exact:true}).click();
  await owner.getByLabel('Review note').fill('Matched shift records');
  await owner.getByRole('button', {name:'Mark as reviewed'}).click();
  await owner.getByText('Matched shift records', {exact:true}).waitFor();
  await owner.locator('#back').click();
  await owner.getByRole('button', {name:'Shift #1', exact:true}).waitFor();
  const downloadEvent = owner.waitForEvent('download');
  await owner.getByRole('button', {name:'Export CSV'}).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'tuljai-petroleum-daily-' + shift.business_date + '.csv');
  const csv = await readFile(await download.path(), 'utf8');
  for (const line of [
    '"Metered sales (INR)","1968"',
    '"UPI (INR)","1000"',
    '"CH-1"',
    '"UTR-1"',
    '"First tab note"',
    '"Matched shift records","450","450"',
  ]) assert.ok(csv.includes(line), 'Missing CSV value: ' + line);
  // Export and print must not use the prior date's numbers while fetching a new date.
  let releaseDate;
  const waitForDate = new Promise(resolve => { releaseDate = resolve; });
  await owner.route('**/api/owner/daily-report?date=2020-01-01', async route => {
    await waitForDate;
    await route.continue();
  });
  await owner.getByLabel('Business date').fill('2020-01-01');
  try {
    await owner.waitForFunction(() => document.querySelector('#export-day')?.disabled);
    assert.equal(await owner.getByRole('button', {name:'Print', exact:true}).isDisabled(), true);
    assert.equal(await owner.getByRole('button', {name:'Share via WhatsApp'}).isDisabled(), true);
  } finally {
    releaseDate();
  }
  await owner.getByText('No shifts were submitted for this business date.').waitFor();
  assert.equal(await owner.getByRole('button', {name:'Export CSV'}).isEnabled(), true);
  await owner.getByRole('button', {name:'Share via WhatsApp'}).click();
  assert.match(await share.getByLabel('Message', {exact:true}).inputValue(), /1 January 2020[\s\S]*No shifts were submitted/);
  await share.getByRole('button', {name:'Close dialog'}).click();
  await owner.getByRole('button', {name:'Today', exact:true}).click();
  await owner.getByRole('button', {name:'Shift #1', exact:true}).waitFor();
  assert.equal(await owner.getByLabel('Business date').inputValue(), shift.business_date);
  await owner.getByRole('button', {name:'Overview', exact:true}).click();
  await owner.getByRole('button', {name:'Open shift 1 report'}).waitFor();
  assert.match(await owner.getByRole('region', {name:'Daily fuel sales'}).textContent(), /1,968\.00/);
  assert.deepEqual(ownerErrors, []);
  await ownerContext.close();
  await page.getByRole('button',{name:'Open shift',exact:true}).click();await page.getByRole('heading',{name:'Shift entries',exact:true}).waitFor();assert.equal(await page.getByLabel('P-01 closing reading (L)').inputValue(),'');assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tuljai-draft:')&&k.endsWith(':1')).length),0);
  assert.deepEqual(errors,[]);
});

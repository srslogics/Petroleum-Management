const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtemp,rm,mkdir}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');

test('Payroll and Payables support staff, advances, salaries, bills, partial payments and audited corrections',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'petroleum-outgoing-'));
  let origin,browser,logs='';
  const server=spawn(process.env.PYTHON||'python3',['-u','app.py','--port','0','--db',path.join(dir,'test.sqlite3')],{cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',PETROLEUM_HOSTED:'',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:''},stdio:'pipe'});
  server.stdout.on('data',chunk=>{logs+=chunk;origin=logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];});server.stderr.on('data',chunk=>{logs+=chunk;});
  t.after(async()=>{if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));await rm(dir,{recursive:true,force:true});});
  for(let i=0;i<100&&!origin;i++){if(server.exitCode!==null)throw Error(logs);await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(origin,logs);
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>{if(['script','stylesheet','font'].includes(r.resourceType()))errors.push(r.url());});
  const login=await context.request.post(origin+'/api/owner/login',{data:{email:'owner@demo.local',password:'OwnerDemo123!'}});assert.equal(login.status(),200);
  await page.goto(origin+'/owner');await page.getByRole('button',{name:'Payroll',exact:true}).click();
  const dialog=page.getByRole('dialog');const close=()=>page.keyboard.press('Escape');
  const save=async name=>{await dialog.getByRole('button',{name,exact:true}).click();await dialog.waitFor({state:'hidden'});};
  await page.getByRole('heading',{name:'No salaries prepared'}).waitFor();
  await page.getByRole('button',{name:'+ Add staff',exact:true}).click();await dialog.getByLabel('Staff name').fill('Asha Patil');await dialog.getByLabel('Monthly salary (₹)').fill('15000');await dialog.getByLabel('Job title (optional)').fill('Attendant');await save('Save staff');
  await page.getByRole('button',{name:'+ Staff advance',exact:true}).click();await dialog.getByLabel('Amount paid (₹)').fill('5000');await dialog.getByLabel('Unique payment reference').fill('ADV-1');await save('Record payment');
  await page.getByRole('button',{name:'+ Add salary',exact:true}).click();assert.equal(await dialog.getByLabel('Salary earned (₹)').inputValue(),'15000.00');await dialog.getByLabel('Apply advance (₹)').fill('3000');await dialog.getByText('Salary to pay: ₹12,000.00',{exact:true}).waitFor();await save('Add salary');
  let row=page.getByRole('row').filter({has:page.getByRole('button',{name:'Asha Patil',exact:true})});await row.getByRole('button',{name:'Pay / details',exact:true}).click();await dialog.getByRole('button',{name:'Record payment',exact:true}).click();await dialog.getByLabel('Amount paid (₹)').fill('7000');await dialog.getByLabel('Unique payment reference').fill('SAL-1');await save('Record payment');
  assert.match(await row.locator('td').nth(3).textContent(),/5,000.00/);
  await page.getByRole('tab',{name:'Advances',exact:true}).click();await page.getByRole('button',{name:'Record return',exact:true}).click();await dialog.getByLabel('Amount returned (₹)').fill('500');await dialog.getByLabel('Unique payment reference').fill('RETURN-1');await save('Record return');
  await page.getByRole('tab',{name:'Staff',exact:true}).click();await page.getByRole('button',{name:'Edit staff',exact:true}).click();await dialog.getByLabel('Monthly salary (₹)').fill('16000');await dialog.getByLabel('Staff status').selectOption('false');await save('Save staff');await page.getByLabel('Record status').selectOption('inactive');await page.locator('[data-out-row]').getByText('Inactive',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Salaries',exact:true}).click();await row.getByRole('button',{name:'Pay / details',exact:true}).click();await dialog.getByRole('button',{name:'Record payment',exact:true}).click();await dialog.getByLabel('Unique payment reference').fill('SAL-1');await dialog.getByRole('button',{name:'Record payment',exact:true}).click();await dialog.locator('.form-error').getByText(/already exists/).waitFor();assert.equal(await dialog.getByLabel('Amount paid (₹)').inputValue(),'5000.00');await dialog.getByLabel('Unique payment reference').fill('SAL-2');await save('Record payment');await row.locator('.money-badge').getByText('Paid',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Payables',exact:true}).click();await page.getByRole('heading',{name:'No bills to pay yet'}).waitFor();
  const addBill=async(kind,payee,ref,amount)=>{await page.getByRole('button',{name:'+ Add bill',exact:true}).click();await dialog.getByLabel('Bill type').selectOption(kind);await dialog.getByLabel('Supplier / payee').fill(payee);await dialog.getByLabel('Invoice / bill reference').fill(ref);await dialog.getByLabel('Bill amount (₹)').fill(amount);await dialog.getByLabel('Description').fill('November purchase');await save('Add bill');};
  await addBill('supplier','Fuel Supplier','INV-1','10000');await addBill('other','Electricity Board','BILL-2','2000');
  await page.getByLabel('Search names or references').fill('Fuel');assert.equal(await page.locator('[data-out-row]:visible').count(),1);await page.getByLabel('Search names or references').fill('missing');await page.getByRole('heading',{name:'No matching records'}).waitFor();await page.getByLabel('Search names or references').fill('');
  let bill=page.getByRole('row').filter({has:page.getByRole('button',{name:'Fuel Supplier',exact:true})});await bill.getByRole('button',{name:'Pay / details',exact:true}).click();await dialog.getByRole('button',{name:'Record payment',exact:true}).click();await dialog.getByLabel('Amount paid (₹)').fill('3000');await dialog.getByLabel('Unique payment reference').fill('BILL-PAY-1');await save('Record payment');assert.match(await bill.locator('td').nth(3).textContent(),/7,000.00/);
  await page.getByRole('tab',{name:'Activity',exact:true}).click();await page.getByRole('button',{name:'Details',exact:true}).click();await dialog.getByRole('button',{name:'Void this record',exact:true}).click();await dialog.getByLabel('Reason for voiding').fill('Wrong bank account');await save('Void record');await page.locator('.money-badge').getByText('Voided',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Bills',exact:true}).click();assert.match(await bill.locator('td').nth(3).textContent(),/10,000.00/);
  // Invoice correction retains original; replacement can reuse its invoice number.
  await bill.getByRole('button',{name:'Pay / details',exact:true}).click();await dialog.getByRole('button',{name:'Void this record',exact:true}).click();await dialog.getByLabel('Reason for voiding').fill('Revised invoice');await save('Void record');await addBill('supplier','Fuel Supplier','INV-1','9000');
  const capture=process.env.SCREENSHOT_DIR;if(capture)await mkdir(capture,{recursive:true});
  for(const view of ['Payroll','Payables']){
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:view,exact:true}).click();
    if(view==='Payroll')await page.getByRole('tab',{name:'Salaries',exact:true}).click();
    for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),view+' overflow at '+width);assert.ok(await page.locator('.money-stat strong').evaluateAll(nodes=>nodes.every(n=>n.clientHeight<=parseFloat(getComputedStyle(n).lineHeight)+2)),view+' wrapped summary value');if(capture&&width!==390)await page.screenshot({path:path.join(capture,view.toLowerCase()+'-'+width+'.png'),fullPage:true});}
    // Hidden desktop columns remain accessible via the name on a phone.
    await page.locator('[data-out-row] .money-source-link').first().click();await dialog.waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await close();
    await page.getByRole('button',{name:'How this works',exact:true}).click();await dialog.getByRole('heading',{name:'How '+view+' works',exact:true}).waitFor();await close();
  }
  assert.deepEqual(errors,[]);
});

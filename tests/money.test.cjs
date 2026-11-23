const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');

test('Money supports empty states, customer search, focused payments, banking and audited voids',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'petroleum-money-'));
  let origin,browser,logs='';
  const server=spawn(process.env.PYTHON||'python3',['-u','app.py','--port','0','--db',path.join(dir,'test.sqlite3')],{
    cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',PETROLEUM_HOSTED:'',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:''},stdio:'pipe',
  });
  server.stdout.on('data',chunk=>{logs+=chunk;origin=logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];});
  server.stderr.on('data',chunk=>{logs+=chunk;});
  t.after(async()=>{if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));await rm(dir,{recursive:true,force:true});});
  for(let i=0;i<100&&!origin;i++){if(server.exitCode!==null)throw Error(logs);await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(origin,logs);
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const post=async(route,data)=>{const result=await context.request.post(origin+'/api/'+route,{data});assert.equal(result.status(),200,await result.text());return result.json();};
  await post('owner/login',{email:'owner@demo.local',password:'OwnerDemo123!'});
  await page.goto(origin+'/owner');await page.getByRole('button',{name:'Money',exact:true}).click();
  await page.getByRole('heading',{name:'Your credit customers, in one place'}).waitFor();
  assert.equal(await page.locator('#money-record-payment').isDisabled(),true);
  await page.getByRole('tab',{name:/^Banking/}).click();await page.getByRole('heading',{name:'No receipts to reconcile yet'}).waitFor();
  await page.getByRole('tab',{name:/^Activity/}).click();await page.getByRole('heading',{name:'Your money trail starts here'}).waitFor();
  await page.getByRole('tab',{name:/^Customers/}).click();
  await page.getByRole('button',{name:'Add your first customer',exact:false}).click();
  await page.getByRole('dialog').getByLabel('Customer / account name').fill('Fleet A');
  await page.getByRole('dialog').getByRole('button',{name:'Save customer'}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Open account for Fleet A',exact:true}).waitFor();
  await post('manager/login',{email:'manager@demo.local',password:'ManagerDemo123!'});
  await post('manager/shift',{openings:{1:100,2:200}});
  await post('manager/shifts/1/submit',{closings:{1:110,2:210},collections:{cash:100,upi:100,card:100},counted:90,expenses:10,
    entries:{payments:[{method:'credit',amount:100,party:'Fleet A'},{method:'credit',amount:200,party:'Fleet B'}]}});
  await post('owner/customers',{name:'Fleet B',due_date:'2026-11-21'});
  await page.getByRole('button',{name:'Overview',exact:true}).click();await page.getByRole('button',{name:'Money',exact:true}).click();
  const rowA=page.getByRole('row').filter({has:page.getByRole('button',{name:'Open account for Fleet A',exact:true})});
  await rowA.getByRole('button',{name:'Record payment',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('Amount received (₹)').fill('100');await dialog.getByLabel('Unique receipt reference').fill('RCPT-FULL');await dialog.getByRole('button',{name:'Record payment',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByLabel('Customer status').selectOption('outstanding');
  assert.equal(await page.getByRole('button',{name:'Open account for Fleet A',exact:true}).isVisible(),false);
  await page.getByLabel('Customer status').selectOption('overdue');await page.getByRole('button',{name:'Open account for Fleet B',exact:true}).waitFor();
  await page.getByLabel('Search customers',{exact:true}).fill('No match');await page.getByRole('heading',{name:'No matching customers'}).waitFor();
  await page.getByLabel('Search customers',{exact:true}).fill('');await page.getByLabel('Customer status').selectOption('all');
  // Tabs support keyboard navigation without submitting or leaving Money.
  await page.getByRole('tab',{name:/^Customers/}).focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab',{name:/^Banking/}).getAttribute('aria-selected'),'true');
  const card=page.getByRole('row').filter({has:page.getByText('Card',{exact:true})});
  await card.getByRole('button',{name:'Record settlement',exact:true}).click();
  await dialog.getByLabel('Net bank receipt (₹)').fill('49.50');await dialog.getByLabel('Settlement fees (₹)').fill('0.50');await dialog.getByLabel('Unique bank / deposit reference').fill('BANK-PART');await dialog.getByRole('button',{name:'Record settlement',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.match(await card.locator('td').nth(4).textContent(),/50.00/);
  await page.getByRole('tab',{name:/^Activity/}).click();
  const bank=page.getByRole('row').filter({has:page.getByText('BANK-PART',{exact:true})});
  await bank.getByRole('button',{name:'View entry',exact:true}).click();await dialog.getByRole('button',{name:'Void this entry',exact:true}).click();
  await dialog.getByLabel('Reason for voiding this entry').fill('Receipt belongs to another settlement');await dialog.getByRole('button',{name:'Void entry',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await bank.getByText('Voided',{exact:true}).waitFor();
  await page.getByLabel('Entry status').selectOption('void');assert.equal(await page.locator('[data-money-activity]:visible').count(),1);
  await page.getByRole('tab',{name:/^Banking/}).click();assert.match(await card.locator('td').nth(4).textContent(),/100.00/);
  await page.setViewportSize({width:320,height:900});
  await page.getByRole('button',{name:/Open Shift #1.*Card receipt/}).click();await dialog.getByLabel('Net bank receipt (₹)').waitFor();await page.keyboard.press('Escape');
  await page.getByRole('tab',{name:/^Customers/}).click();
  const rowB=page.getByRole('row').filter({has:page.getByRole('button',{name:'Open account for Fleet B',exact:true})});
  assert.equal(await rowB.locator('td').nth(3).isVisible(),true);
  assert.match(await rowB.locator('td').nth(3).textContent(),/200.00/);
  await page.getByRole('button',{name:'Open account for Fleet B',exact:true}).click();await dialog.getByRole('button',{name:'Record payment',exact:true}).click();
  assert.equal(await dialog.getByLabel(/^Customer/).inputValue(),'fleet b');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Money help',exact:true}).click();await dialog.getByRole('heading',{name:'How Money works',exact:true}).waitFor();await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);
});

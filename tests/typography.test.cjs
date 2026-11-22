const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {mkdtemp, rm, mkdir} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');

test('typography stays consistent across roles, reports, phone layouts and offline launches', async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'petroleum-type-'));
  let origin, browser, logs = '';
  const server = spawn(process.env.PYTHON || 'python3', ['-u','app.py','--port','0','--db',path.join(directory,'test.sqlite3')], {
    cwd:path.join(__dirname,'..'), env:{...process.env,RENDER:'',PETROLEUM_HOSTED:'',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:''}, stdio:'pipe',
  });
  server.stdout.on('data', chunk => { logs += chunk; origin = logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; });
  server.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit',resolve));
    await rm(directory,{recursive:true,force:true});
  });
  for (let i=0;i<100&&!origin;i++) {
    if (server.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.ok(origin, logs);
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  const post = async (route, data) => {
    const result = await context.request.post(origin + '/api/' + route,{data});
    assert.equal(result.status(),200,await result.text()); return result.json();
  };
  const audit = async (name, {mobile=true, table=false}={}) => {
    for (const width of mobile ? [1440,1024,390,320] : [1440]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(async () => { await document.fonts.load('400 16px Inter','Text ₹'); await document.fonts.ready; });
      const result = await page.evaluate(() => {
        const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
        const text = selector => [...document.querySelectorAll(selector)].filter(visible);
        const style = element => {
          const s=getComputedStyle(element); return {font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,line:s.lineHeight};
        };
        return {
          title:style(document.querySelector('h1')), sections:text('h2').map(style),
          inputs:text('input,textarea,select').map(style), buttons:text('button').map(style),
          tables:text('table').map(style), loaded:document.fonts.check('400 16px Inter','Text ₹'),
          overflow:document.documentElement.scrollWidth > innerWidth+1,
          tiny:text('label,small,p,summary,button,td,th').filter(el => parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.textContent.slice(0,50)),
        };
      });
      assert.equal(result.loaded,true,name + ': bundled font unavailable');
      assert.match(result.title.font,/Inter/,name);
      assert.equal(result.title.size,'28px',name + ': title size');
      assert.equal(result.title.weight,'600',name + ': title weight');
      for (const section of result.sections) assert.equal(section.size,'18px',name + ': section heading');
      for (const input of result.inputs) {
        assert.equal(input.size,'16px',name + ': input size');
        assert.equal(input.weight,'400',name + ': input weight');
      }
      for (const button of result.buttons) {
        assert.match(button.font,/Inter/,name + ': button family');
        assert.equal(button.size,'14px',name + ': button size');
      }
      if (table) {
        assert.ok(result.tables.length,name + ': missing table');
        for (const row of result.tables) assert.equal(row.size,'14px',name + ': table size');
      }
      assert.deepEqual(result.tiny,[],name + ': unreadably small text');
      assert.equal(result.overflow,false,name + ': horizontal page overflow at ' + width);
      if (process.env.TYPOGRAPHY_SCREENSHOT_DIR && [1440,390].includes(width)) {
        await mkdir(process.env.TYPOGRAPHY_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({animations:'disabled',path:path.join(process.env.TYPOGRAPHY_SCREENSHOT_DIR,name + '-' + width + '.png'),fullPage:true});
      }
    }
  };

  await page.goto(origin+'/owner');
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  await audit('owner-sign-in');
  await post('manager/login',{email:'manager@demo.local',password:'ManagerDemo123!'});
  await post('manager/shift',{openings:{1:100,2:200}});
  await post('manager/shifts/1/submit',{closings:{1:110,2:210},collections:{cash:100,upi:200,card:300},expenses:10,counted:90,
    entries:{payments:[{method:'credit',amount:400,party:'Fleet A',reference:'INV-1'}]}});
  await page.getByRole('button',{name:'Fill demo sign-in'}).click();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Station overview'}).waitFor();
  await audit('owner-overview',{table:true});
  for (const name of ['Daily report','Money','Operations','Exceptions','Settings','Team']) {
    await page.getByRole('button',{name,exact:true}).click();
    await page.locator('h1').filter({hasText:name === 'Settings' ? 'Station settings' : name === 'Exceptions' ? 'Exception inbox' : name}).waitFor();
    if (name === 'Money') await page.locator('.business-record summary').filter({hasText:'Fleet A'}).click();
    await audit('owner-'+name.toLowerCase().replace(' ','-'),{table:['Money','Daily report'].includes(name)});
    if (name === 'Daily report') {
      await page.emulateMedia({media:'print'});
      assert.equal(await page.locator('.workspace-sidebar').isVisible(),false);
      assert.equal(await page.locator('.report-table').first().evaluate(el=>getComputedStyle(el).fontSize),'12px');
      await page.emulateMedia({media:'screen'});
    }
  }
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Open shift 1 report'}).click();
  await page.getByRole('heading',{name:'Shift #1',exact:true}).waitFor();
  await audit('owner-shift-report');
  await page.getByRole('button',{name:'Correct report figures'}).click();
  await page.getByRole('heading',{name:'Correct submitted shift'}).waitFor();
  await audit('owner-correction-form');

  await page.goto(origin+'/manager');
  await page.getByRole('heading',{name:'Open a shift',exact:true}).waitFor();
  await audit('manager-opening');
  await page.getByRole('button',{name:'Open shift',exact:true}).click();
  await page.getByRole('heading',{name:'Close shift',exact:true}).waitFor();
  await page.getByRole('button',{name:'Add entry',exact:true}).nth(1).click();
  await audit('manager-closing');
  await page.getByRole('button',{name:'Owner requests',exact:true}).click();
  await page.getByRole('heading',{name:'Owner requests',exact:true}).waitFor();
  await audit('manager-requests');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  await audit('manager-sign-in');

  // The offline fallback must keep both the font and stylesheet after the network disappears.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
  });
  const cachedFonts = await page.evaluate(async () => Promise.all(['/fonts/inter-latin.woff2','/fonts/inter-latin-ext.woff2'].map(async file => {
    const response = await caches.match(file); return response?.ok && (await response.arrayBuffer()).byteLength > 0;
  })));
  assert.deepEqual(cachedFonts,[true,true]);
  await context.setOffline(true);
  await page.goto(origin+'/owner');
  await page.getByRole('heading',{name:'Connect to your station'}).waitFor();
  await audit('offline');
  await context.setOffline(false);
  assert.deepEqual(failures,[]);
});

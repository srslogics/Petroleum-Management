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

  const auditAuthLayout = async () => {
    for (const [width,height] of [[1440,900],[390,844],[320,568],[844,390]]) {
      await page.setViewportSize({width,height});
      const layout = await page.locator('.auth-page').evaluate(surface => {
        const measure = selector => {
          const {left,right,top,bottom} = surface.querySelector(selector).getBoundingClientRect();
          return {left,right,top,bottom};
        };
        return {
          brand:measure('.auth-brand-panel'), form:measure('.auth-content'), footer:measure('.auth-footer'),
          children:[...surface.children].map(element => element.className),
          surfaceBackground:getComputedStyle(surface).backgroundImage,
          brandBackground:getComputedStyle(surface.querySelector('.auth-brand-panel')).backgroundColor,
          formBackground:getComputedStyle(surface.querySelector('.auth-content')).backgroundColor,
          hasHorizontalScroll:document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      assert.deepEqual(layout.children,['auth-brand-panel','auth-content','auth-footer']);
      assert.match(layout.surfaceBackground,/^linear-gradient\(.*rgb\(12, 34, 60\).*rgb\(21, 92, 131\)/);
      assert.equal(layout.brandBackground,'rgba(0, 0, 0, 0)');
      assert.equal(layout.formBackground,'rgba(0, 0, 0, 0)');
      assert.equal(layout.hasHorizontalScroll,false);
      assert.equal(layout.brand.left,0);
      assert.equal(layout.brand.top,0);
      assert.equal(layout.form.right,width);
      if (width <= 680) {
        assert.equal(layout.brand.right,width);
        assert.equal(layout.form.left,0);
        assert.equal(layout.form.top,layout.brand.bottom);
        assert.equal(layout.footer.top,layout.form.bottom);
        assert.ok(layout.footer.bottom >= height);
      } else {
        assert.equal(layout.form.left,layout.brand.right);
        assert.equal(layout.form.top,0);
        assert.equal(layout.footer.top,layout.form.bottom);
        assert.equal(layout.brand.bottom,layout.footer.bottom);
        assert.ok(layout.brand.bottom >= height);
      }
    }
  };

  await page.goto(origin+'/owner');
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  await audit('owner-sign-in');
  await auditAuthLayout();

  await post('manager/login',{email:'manager@demo.local',password:'ManagerDemo123!'});
  await post('manager/shift',{openings:{1:100,2:200}});
  await post('owner/login',{email:'owner@demo.local',password:'OwnerDemo123!'});
  await post('owner/shifts/1/submit',{closings:{1:110,2:210},collections:{cash:100,upi:200,card:300},expenses:10,counted:90,
    entries:{payments:[{method:'credit',amount:400,party:'Fleet A',reference:'INV-1'}]}});
  await page.getByRole('button',{name:'Fill demo sign-in'}).click();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Station overview'}).waitFor();
  await audit('owner-overview',{table:true});
  assert.match(await page.getByRole('region',{name:'Daily fuel sales'}).evaluate(element => getComputedStyle(element).backgroundImage), /rgb\(12, 34, 60\)/);
  const submitted = page.getByRole('region',{name:'Submitted shifts'});
  assert.ok(await submitted.evaluate(region => region.scrollWidth <= region.clientWidth + 1));
  await submitted.getByRole('button',{name:'Open shift 1 report'}).waitFor();
  for (const name of ['Daily report','Ledger','Receivables','Payroll','Payables','Automation','Operations','Banking','Exceptions','Settings','Contacts','Team']) {
    await page.setViewportSize({width:1440,height:1000});
    const financeTab = {Receivables:'To collect', Payables:'To pay', Payroll:'To pay', Banking:'Banking'}[name];
    await page.getByRole('button',{name:financeTab ? 'Ledger' : name,exact:true}).click();
    if (financeTab) {
      await page.getByRole('navigation',{name:'Money tools'}).getByText('Money tools',{exact:true}).click();
      await page.getByRole('button',{name:financeTab,exact:true}).click();
      await page.getByRole('heading',{name:financeTab,exact:true,level:1}).waitFor();
      if (name === 'Payroll') await page.getByRole('tab',{name:'Salaries',exact:true}).click();
    }
    await page.locator('h1').filter({hasText:financeTab || (name === 'Ledger' ? 'Party ledger' : name === 'Settings' ? 'Station settings' : name === 'Exceptions' ? 'Exception inbox' : name)}).waitFor();

    await audit('owner-'+name.toLowerCase().replace(' ','-'),{table:['Receivables','Daily report','Ledger'].includes(name)});
    if (name === 'Automation') assert.ok(await page.locator('.auto-tabs').evaluate(tabs => tabs.scrollWidth <= tabs.clientWidth + 1));
    if (name === 'Receivables') {
      await page.getByRole('tab',{name:/^Fuel credit/}).click();
      await page.getByRole('button',{name:'Open account for Fleet A',exact:true}).click();
      await audit('money-account-drawer',{table:true});
      await page.getByRole('dialog').getByRole('button',{name:'Record payment',exact:true}).click();
      await audit('money-payment-form');
      await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    }
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
  assert.ok(await page.getByRole('navigation',{name:'Station Manager App navigation'}).evaluate(nav => nav.scrollWidth <= nav.clientWidth + 1));
  await page.getByRole('button',{name:'Open shift',exact:true}).click();
  await page.getByRole('heading',{name:'Shift entries',exact:true}).waitFor();
  await page.getByRole('button',{name:'Collections',exact:true}).click();
  await page.locator('.manager-optional summary').filter({hasText:'Payment batch'}).click();
  await page.getByRole('button',{name:'Add entry',exact:true}).click();
  await audit('manager-closing');
  for(const name of ['Meters & stock','Deliveries','Expenses']){await page.getByRole('button',{name,exact:true}).click();await audit('manager-'+name);}
  await page.getByRole('button',{name:'Owner requests',exact:true}).click();
  await page.getByRole('heading',{name:'Owner requests',exact:true}).waitFor();
  await audit('manager-requests');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  await audit('manager-sign-in');
  await auditAuthLayout();

  // The offline fallback must keep its typography and colors after the network disappears.
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
  assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(240, 245, 250)');
  await context.setOffline(false);
  assert.deepEqual(failures,[]);
});

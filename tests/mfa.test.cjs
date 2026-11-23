const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {mkdtemp, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');

test('both apps can enroll an authenticator and sign in with a recovery code', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tuljai-mfa-'));
  const python = process.env.PYTHON || 'python3';
  const server = spawn(python, ['-u', 'app.py', '--port', '0', '--db', path.join(dir, 'test.sqlite3')], {
    cwd: path.join(__dirname, '..'),
    env: {...process.env, RENDER:'', PETROLEUM_HOSTED:'', TURSO_DATABASE_URL:'', TURSO_AUTH_TOKEN:'',
      MFA_ENCRYPTION_KEY:randomBytes(32).toString('base64')},
  });
  let logs = '', origin, browser;
  server.stdout.on('data', chunk => {
    logs += chunk;
    origin = logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  });
  server.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (browser) await browser.close();
    server.kill();
    if (server.exitCode === null && server.signalCode === null) await new Promise(resolve => server.once('exit', resolve));
    await rm(dir, {recursive:true, force:true});
  });
  for (let i=0; i<100 && !origin && server.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(origin, logs);
  browser = await chromium.launch();
  for (const role of ['owner','manager']) {
    const page = await browser.newPage({viewport:{width:390,height:850}});
    const password = role === 'owner' ? 'OwnerDemo123!' : 'ManagerDemo123!';
    const signIn = async () => {
      await page.getByLabel('Mobile number or email').fill(role+'@demo.local');
      await page.locator('#password').fill(password);
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
    };
    await page.goto(origin+'/'+role);
    await signIn();
    await page.getByRole('button',{name:'Account security'}).click();
    await page.getByLabel('Current password').fill(password);
    await page.getByRole('button',{name:'Set up authenticator'}).click();
    const seed = await page.getByLabel('Setup key').inputValue();
    const code = execFileSync(python, ['-c','import sys,time; from mfa import totp; print(totp(sys.argv[1],int(time.time())//30))',seed],
      {cwd:path.join(__dirname,'..'),encoding:'utf8'}).trim();
    await page.getByLabel('Six-digit code').fill(code);
    await page.getByRole('button',{name:'Turn on verification'}).click();
    const recoveryCode = (await page.getByLabel('Recovery codes').inputValue()).split('\n')[0];
    await page.getByRole('button',{name:'I saved my codes. Sign in'}).click();
    await signIn();
    const verification = page.getByLabel('Authenticator or recovery code');
    await verification.waitFor();
    assert.equal((await page.request.get(origin+'/api/'+role+'/session')).status(),401);
    await verification.fill(recoveryCode);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Account security'}).click();
    await page.getByText('On for this account.',{exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.close();
  }
});

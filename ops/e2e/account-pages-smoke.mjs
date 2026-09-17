// Modern account pages; fixtures are isolated and removed, secrets are never logged.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {actors, call, USER_SERVER, enc} from './rest/lib.mjs';
const area=process.argv[2] || 'profile';
const base=process.env.CEDAR_BASE || 'https://workspace.metadatacenter.orgx';
const {user1}=await actors();
const userId=JSON.parse(Buffer.from(user1.auth.split('.')[1],'base64url').toString()).sub;
const userPath='/users/'+enc(userId);
let originalDate;
const fixture='Workspace account smoke '+Date.now();
const browser=await chromium.launch({headless:!process.env.HEADED});
const context=await browser.newContext({ignoreHTTPSErrors:true});
const page=await context.newPage();
page.setDefaultTimeout(25000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
async function open(route){await page.goto(base+route);await page.locator('#username, cedar-account-shell .account-card, cedar-account-shell [role=alert]').first().waitFor();if(await page.locator('#username').isVisible()){await page.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN||'test1@test.com');await page.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD||'test1');await page.locator('#kc-login').click();}await page.getByRole('heading',{name:route.slice(1)[0].toUpperCase()+route.slice(2),exact:true}).waitFor();assert.equal(await page.evaluate(()=>typeof window.angular),'undefined');}
async function mutation(method,path,action,status){const pending=page.waitForResponse(r=>r.request().method()===method&&new URL(r.url()).pathname.includes(path));await action();const response=await pending;assert.equal(response.status(),status);return response;}
try {
 if(area==='profile'){
  await open('/profile');await page.getByRole('heading',{name:/API Keys/}).waitFor();
  await page.getByLabel('New key description (optional)').fill(fixture);
  await mutation('POST','/api-keys',()=>page.getByRole('button',{name:'New key',exact:true}).click(),201);
  const key=()=>page.getByRole('article',{name:fixture,exact:true});await key().waitFor();
  assert.match(await key().locator('code').innerText(),/^•+$/);
  await key().getByRole('button',{name:'Reveal',exact:true}).click();await key().getByRole('button',{name:'Hide',exact:true}).waitFor();assert.ok(!(await key().locator('code').innerText()).includes('•'));
  await key().getByRole('button',{name:'Hide',exact:true}).click();
  await mutation('POST','/regenerate',()=>key().getByRole('button',{name:'Regenerate',exact:true}).click(),200);
  await page.getByRole('status').filter({hasText:'API key regenerated.'}).waitFor();
  await mutation('DELETE','/api-keys/',()=>key().getByRole('button',{name:'Delete',exact:true}).click(),200);
  await key().waitFor({state:'detached'});
  await page.getByRole('link',{name:'← Workspace',exact:true}).click();await page.locator('cedar-workspace-page').waitFor();
  console.log('PASS: Profile is Angular-only; account, key create/reveal/hide/regenerate/delete, and Workspace return');
 }
 if(area==='settings'){
  const original=await call(user1.auth,'GET',userPath,undefined,{base:USER_SERVER});assert.equal(original.status,200);
  originalDate=original.body.uiPreferences?.preferredDateFormat || 'MM/DD/YYYY';
  const next=originalDate==='YYYY-MM-DD'?'DD/MM/YYYY':'YYYY-MM-DD';
  await open('/settings');
  await mutation('PUT','/users/',()=>page.getByLabel('Date format',{exact:true}).selectOption(next),200);
  await page.getByRole('status').filter({hasText:'Date format saved.'}).waitFor();
  await page.reload();await page.locator('.account-card').first().waitFor();
  assert.equal(await page.getByLabel('Date format',{exact:true}).inputValue(),next);
  console.log('PASS: Settings is Angular-only; date format saves and survives reload');
 }
 assert.deepEqual(errors,[]);
} catch (error) { console.error('Account alerts:', await page.getByRole('alert').allTextContents()); console.error('Browser errors:', errors); throw error; } finally {
 await browser.close();
 if(originalDate!==undefined){const restored=await call(user1.auth,'PUT',userPath,{'uiPreferences.preferredDateFormat':originalDate},{base:USER_SERVER});assert.equal(restored.status,200,'Date preference restore failed');}
 const current=await call(user1.auth,'GET',userPath,undefined,{base:USER_SERVER});
 assert.equal(current.status,200);
 for(const key of current.body.apiKeys||[]){if(key.description===fixture){const result=await call(user1.auth,'DELETE',userPath+'/api-keys/'+enc(key.id),undefined,{base:USER_SERVER});assert.equal(result.status,200,'Temporary key cleanup failed');}}
}

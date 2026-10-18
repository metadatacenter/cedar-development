import { withBrowserAuthentication } from "./auth-activity.mjs";
import assert from 'node:assert/strict';
import {actors,artifactBody,call,enc} from './rest/lib.mjs';
import {groupAccessJourney} from './group-access-journey.mjs';
import {journeyFolder} from './journey-fixtures.mjs';
// Provisioning for the group-access journey: a template and a record based on it. The full smoke and
// the focused runner both run it as access-recheck.
//
// It signs the second test user in to a browser context of its own, so it belongs in the identity
// lane. The group it creates has a name unique to the run, and group names are unique server-wide.
export async function accessRecheckJourney({page,base,designer,user,folderId,name,created,write,pass}) {
  folderId=await journeyFolder({user,folderId,name,created},'access recheck');
  const template=artifactBody('template',name+' access template');
  template.properties.Notes=artifactBody('field','Notes');
  template.properties['@context'].properties.Notes={enum:['https://example.org/access/Notes']};
  template._ui.order.push('Notes');template._ui.propertyLabels.Notes='Notes';template.required.push('Notes');
  async function create(collection,body){
    const made=await call(user.auth,'POST','/'+collection+'?folder_id='+enc(folderId),body);
    assert.equal(made.status,201,made.text);created.push({collection,id:made.body['@id']});return made.body['@id'];
  }
  const templateId=await create('templates',template);
  const instance=artifactBody('instance',name+' access metadata',{'schema:isBasedOn':templateId,Notes:{'@value':'Opened'}});
  instance['@context'].Notes='https://example.org/access/Notes';instance['@context']['pav:derivedFrom']={'@type':'@id'};
  const id=await create('template-instances',instance),{user2}=await actors();
  const context=await page.context().browser().newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:1000}});
  const reader=await context.newPage();reader.on('dialog',dialog=>dialog.accept());
  try {
    await withBrowserAuthentication("permission reader sign-in", async () => {
      await reader.goto(base+'/dashboard');
      await reader.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER2_LOGIN||'test2@test.com');
      await reader.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER2_PASSWORD||'test2');
      await reader.locator('#kc-login').click();await reader.getByRole('button',{name:'New',exact:true}).waitFor();
    });
    await groupAccessJourney({page,reader,base,designer,owner:user,member:user2,templateId,
      instancePath:'/template-instances/'+enc(id),metadataUrl:base+'/instances/edit/'+enc(id),name,write,pass});
  } finally {await context.close();}
}

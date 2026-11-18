import assert from 'node:assert/strict';
import {metadataFixtures} from './fixtures.mjs';
import {WIDTHS} from './catalog.mjs';
import {pointer,keyboard} from './interactions.mjs';
export async function collectMetadataEditor(session,record) {
  const {page}=session;await session.login();const f=await metadataFixtures(session);
  async function ready(){
    await page.locator('#instance-name').waitFor();
    await page.waitForFunction(()=>{
      const status=document.querySelector('.metadata-toolbar [role=status]')?.textContent;
      return status&&/Unmodified|Modified|Saved/.test(status);
    });
    await page.locator('cedar-embeddable-editor h1').waitFor();
  }
  async function open(id,mode='edit'){
    await page.goto(session.base+'/instances/'+mode+'/'+encodeURIComponent(id)+'?'+new URLSearchParams({folderId:f.folder}));
    await ready();
  }
  const cee=page.locator('cedar-embeddable-editor');
  const pager=()=>cee.locator('app-cedar-multi-pager').first();
  for(const width of WIDTHS){
    const r=(id,fn,note)=>record(`${id}-${width}`,fn,note);
    await page.setViewportSize({width,height:width===1440?1000:667});
    for(const count of [0,1,2,5,6,12])await r('occurrences-'+count,async()=>{
      await open(f.records[count]);await pager().scrollIntoViewIfNeeded();
    });
    await r('last-page',async()=>{
      const next=pager().getByRole('button',{name:'Next page',exact:true});
      for(let i=0;i<2;i++)await pointer(session,next);
      await pager().getByRole('option',{name:'12',exact:true}).waitFor();
      await pointer(session,pager().getByRole('option',{name:'12',exact:true}));
    });
    await r('previous-page',async()=>{await pointer(session,pager().getByRole('button',{name:'Previous page',exact:true}));await pager().getByRole('option',{name:'6',exact:true}).waitFor();});
    await r('long-labels',()=>cee.locator('app-cedar-multi-pager').nth(1).scrollIntoViewIfNeeded());
    await r('nested',async()=>{await cee.locator('mat-expansion-panel').first().scrollIntoViewIfNeeded();});
    await r('nested-end',async()=>{await cee.locator('mat-expansion-panel').last().getByRole('textbox').last().scrollIntoViewIfNeeded();});
    await r('keyboard',()=>keyboard(session,cee.getByRole('textbox',{name:'Subject',exact:true})));
    const value='Reviewed specimen '+width;
    await r('edited',async()=>{await cee.getByRole('textbox',{name:'Subject',exact:true}).fill(value);await page.locator('.metadata-toolbar [role=status]').filter({hasText:'Modified'}).waitFor();});
    await r('saved',async()=>{
      await pointer(session,page.locator('#button-save-metadata'));
      await page.locator('.metadata-toolbar [role=status]').filter({hasText:'Saved'}).waitFor();
      const result=await session.request('GET','/template-instances/'+encodeURIComponent(f.records[12]));
      assert.equal(result.status,200);assert.equal(result.body.Subject['@value'],value);
    });
    await r('reopened',async()=>{await open(f.records[12]);assert.equal(await cee.getByRole('textbox',{name:'Subject',exact:true}).inputValue(),value);});
    await r('new-record',()=>open(f.templateId,'create'));
    await r('empty-template',()=>open(f.emptyTemplateId,'create'));
  }
}

import assert from 'node:assert/strict';
import {captureJourney} from './journeys.mjs';
import {richFixture} from './rich-fixtures.mjs';
import {RICH_FIELDS} from './rich-definitions.mjs';
import {showRichField} from './rich-states.mjs';
import {openviewFixtures,makeOpen} from './fixtures.mjs';
import {WIDTHS,PAIRED_WIDTHS} from './catalog.mjs';
import {enc,HOST} from '../rest/lib.mjs';
import {textSizeStates,holdRequests} from './interactions.mjs';

// OpenView is public: the browser carries no CEDAR session, and only reads what the review opened.
export async function collectOpenView(session,record) {
  const {page,base}=session;
  const f=await openviewFixtures(session);
  const cee=page.locator('cedar-embeddable-editor');
  const go=path=>page.goto(base+path);
  // Rendered means OpenView drew the artifact itself, whose name it shows as the page's heading,
  // not merely that the page and its footer loaded.
  const rendered=async(path,name)=>{
    await go(path);
    await page.getByRole('heading',{name,exact:true}).first().waitFor();
  };
  const toEnd=()=>page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
  for(const width of WIDTHS){
    await captureJourney(session,record,`public-artifacts-${width}`,async()=>{
    const r=(id,fn,note)=>record(`${id}-${width}`,fn,note);
    await page.setViewportSize({width,height:width===1440?1000:667});
    await r('template',()=>rendered(`/templates/${enc(f.template)}`,f.name+' open study'));
    await r('template-end',toEnd);
    await r('instance',()=>rendered(`/template-instances/${enc(f.record)}`,f.name+' open study'));
    await r('instance-repeated',()=>cee.locator('app-cedar-multi-pager').first().evaluate(element=>element.scrollIntoView({block:'center'})));
    await r('element',()=>rendered(`/template-elements/${enc(f.element)}`,'Open sample element'));
    await r('field',()=>rendered(`/template-fields/${enc(f.single)}`,'Open specimen field'));
    await r('folder',async()=>{await go(`/folders/${enc(f.folder)}`);await page.locator('section.folder ul.resources li').first().waitFor();});
    await r('field-types',()=>rendered(`/templates/${enc(f.fieldTypes)}`,f.name+' open field types'));
    await r('field-types-end',toEnd);
    // OpenView's server refuses these two requests, and the browser logs each refusal.
    session.expectedNetworkFailures.add('OpenView refuses a template that is not open (401) and an identifier no artifact has (404)');
    await r('not-open',async()=>{await go(`/templates/${enc(f.closed)}`);await page.locator('app-artifact-error').waitFor();},
      'A template the review did not open, in a folder that is not open.');
    await r('missing',async()=>{await go(`/templates/${enc(f.template.replace(/[0-9a-f]{12}$/,'000000000000'))}`);await page.locator('app-artifact-error').waitFor();},
      'An identifier no artifact has.');
    session.expectedNetworkFailures.clear();
    });
  }
  // A row's preview in a folder, and the spinner while a page waits for its artifact.
  for(const width of PAIRED_WIDTHS){
    await captureJourney(session,record,`public-preview-loading-${width}`,async()=>{
    const r=(id,fn,note)=>record(`${id}-${width}`,fn,note);
    await page.setViewportSize({width,height:width===1440?1000:667});
    await r('folder-preview',async()=>{
      await go(`/folders/${enc(f.folder)}`);await page.locator('section.folder ul.resources li').first().waitFor();
      await page.locator(`[data-preview-id="${f.template}"]`).click();
      await page.locator('dialog.artifact-preview[open]:not(.is-preparing)').waitFor();
    },'The preview a folder row opens.');
    const preview=page.locator('dialog.artifact-preview[open]');
    await r('folder-preview-tryout',async()=>{
      await preview.locator('.try-out').click();await preview.locator('.try-out-notice').waitFor();
      const subject=preview.getByRole('textbox',{name:'Subject',exact:true});
      await subject.fill('Preview specimen');
    },'The public template preview is editable in Try out; the typed specimen is never saved.');
    await r('folder-preview-return',async()=>{
      await preview.locator('.try-out').click();await preview.locator('.try-out-notice').waitFor({state:'detached'});
      await preview.locator('section[aria-busy="false"]').waitFor();
      // CEE config is a write-only input. An empty read-only field renders its specification,
      // not an input; verify that presentation and the removal of the unsaved Try out value.
      const subject=preview.locator('[cedarFieldPresentation]').filter({has:page.getByText('Subject',{exact:true})});
      await subject.locator('app-cedar-spec-box').waitFor();
      assert.equal(await preview.getByRole('textbox',{name:'Subject',exact:true}).count(),0);
      assert.equal(await preview.getByText('Preview specimen',{exact:true}).count(),0);
    },'Returning from Try out restores the ordinary read-only preview.');
    await page.keyboard.press('Escape');await preview.waitFor({state:'detached'});
    await r('folder-empty',async()=>{
      await go(`/folders/${enc(f.empty)}`);await page.locator('section.folder .empty-title').waitFor();
    },'An opened, empty temporary folder, viewed anonymously.');
    let held;
    await r('loading',async()=>{
      // OpenView's page reads artifacts from its own API host, open.<domain>.
      held=await holdRequests(page,url=>url.hostname===`open.${HOST}`,{held:request=>request.method()==='GET',label:'OpenView artifact read'});
      await page.goto(base+`/templates/${enc(f.template)}`,{waitUntil:'domcontentloaded'});
      await held.started();await page.locator('app-spinner .loading-spinner').waitFor();
    },'The harness holds the artifact\'s response to show loading; the server is not slow.');
    await held?.release();await page.getByRole('heading',{name:f.name+' open study',exact:true}).first().waitFor();
    });
  }
  const rich=await richFixture(session,f.folder,'UI review public rich specimen');
  await makeOpen(session,'templates',rich.template);await makeOpen(session,'template-instances',rich.record);
  for(const width of PAIRED_WIDTHS)await captureJourney(session,record,`public-rich-${width}`,async()=>{
    await page.setViewportSize({width,height:width===1440?1000:667});
    await rendered(`/template-instances/${enc(rich.record)}`,rich.name);
    for(const [slug,label] of RICH_FIELDS)await record(`rich-readonly-${slug}-${width}`,()=>showRichField(cee,slug,label),
      'The populated record rendered anonymously by OpenView. Stored authority labels are fixture data; image and rich text are embedded authored content.');
  });
  await captureJourney(session,record,'text-size',async()=>{await textSizeStates(session,record,()=>rendered(`/templates/${enc(f.template)}`,f.name+' open study'));});
}

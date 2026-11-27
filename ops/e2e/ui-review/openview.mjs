import {captureJourney} from './journeys.mjs';
import {openviewFixtures} from './fixtures.mjs';
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
      await page.locator('.resource-preview').first().click();
      await page.locator('dialog.artifact-preview[open]:not(.is-preparing)').waitFor();
    },'The preview a folder row opens.');
    await page.keyboard.press('Escape');await page.locator('dialog.artifact-preview[open]').waitFor({state:'detached'});
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
  await captureJourney(session,record,'text-size',async()=>{await textSizeStates(session,record,()=>rendered(`/templates/${enc(f.template)}`,f.name+' open study'));});
}

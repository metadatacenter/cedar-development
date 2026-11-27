import {test} from 'node:test';
import assert from 'node:assert/strict';
import {APPS,PROFILES,scenarios} from './catalog.mjs';

test('every scenario has readable setup context without changing its stable identifier',()=>{
  for(const app of APPS)for(const profile of Object.keys(PROFILES))for(const s of scenarios(app,profile)){
    assert(s.title?.length>3,s.id);assert(s.description?.length>20,s.id);
    assert(!s.description.includes('undefined'),s.id);
  }
  const designer=Object.fromEntries(scenarios('designer').map(s=>[s.id,s]));
  assert.match(designer['empty-panel-a'].title,/Overview closed/);
  assert.match(designer['single-preview-a'].title,/Preview open/);
  assert.match(designer['type-rrid-preview'].description,/read-only Preview/);
  assert.match(designer['type-pfas-configuration-end'].title,/PFAS.*end of settings/);
  assert.match(scenarios('workspace').find(s=>s.id==='type-menu-1440').title,/Type menu/);
  assert.match(scenarios('metadata-editor').find(s=>s.id==='occurrences-12-375').title,/12 repeated entries/);
});

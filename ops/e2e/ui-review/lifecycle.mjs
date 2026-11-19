import {isDeepStrictEqual} from 'node:util';

// Kept independent of the browser so lost replies and cleanup failures can be tested directly.
export class FixtureLedger {
  constructor({request, persist, mint, userPath, preferences, userBase}) {
    Object.assign(this, {request, persist, mint, userPath, userBase});
    this.preferences = structuredClone(preferences);
    this.fixtures = []; this.cleanup = []; this.cleanupErrors = [];
    this.pendingCreates = new Set(); this.closing = false;
  }
  async register(collection, id) {
    if (!['folders','templates','template-elements','template-fields','template-instances'].includes(collection)) throw new Error('Unsupported fixture collection');
    if (this.fixtures.some(f=>f.id===id)) return;
    const existing = await this.request('GET', `/${collection}/${encodeURIComponent(id)}`);
    if (existing.status !== 404) throw new Error('Refusing to own an existing or unreadable artifact');
    this.fixtures.push({collection,id,registeredAt:new Date().toISOString()});
    await this.persist(); // Before the request: an unanswered write still has a known cleanup identity.
  }
  put(collection, body, folderId) {
    if(this.closing)throw new Error('Fixture session is closing');
    const operation=(async()=>{
    const id = this.mint(collection);
    await this.register(collection,id);
    const result = await this.request('PUT', `/${collection}/${encodeURIComponent(id)}${folderId?'?folder_id='+encodeURIComponent(folderId):''}`, {...body,'@id':id});
    if (result.status !== 201) throw new Error(`Fixture ${collection} create returned ${result.status}: ${JSON.stringify(result.body)}`);
    return id;
    })();
    this.pendingCreates.add(operation);
    return operation.finally(()=>this.pendingCreates.delete(operation));
  }
  async close() {
    this.closing=true;
    await Promise.allSettled([...this.pendingCreates]);
    for (const fixture of [...this.fixtures].reverse()) {
      const row = {...fixture};
      try {
        const path = `/${fixture.collection}/${encodeURIComponent(fixture.id)}`;
        const current = await this.request('GET',path);
        if (current.status !== 404) {
          if (current.status !== 200) throw new Error(`Fixture read returned ${current.status}`);
          const detail = current.headers?.get('etag') ? current : await this.request('GET',path+'/details');
          const etag = detail.headers?.get('etag');
          if (!etag) throw new Error('Refusing deletion without ETag');
          const deleted = await this.request('DELETE',path,undefined,{headers:{'If-Match':etag}});
          row.deleteStatus=deleted.status;
          if (![204,404].includes(deleted.status)) throw new Error(`Conditional delete returned ${deleted.status}`);
        }
        row.getStatus = (await this.request('GET',path)).status;
        if (row.getStatus !== 404) throw new Error('Fixture remains readable after cleanup');
      } catch (error) {row.error=error.message;this.cleanupErrors.push(`${fixture.id}: ${error.message}`);}
      this.cleanup.push(row);await this.persist();
    }
    try {
      const options = {base:this.userBase};
      const current = await this.request('GET',this.userPath,undefined,options);
      if (current.status !== 200) throw new Error('Cannot read account preferences');
      const actual = current.body.uiPreferences;
      for (const key of new Set([...Object.keys(this.preferences??{}),...Object.keys(actual??{})])) {
        if (isDeepStrictEqual(this.preferences?.[key],actual?.[key])) continue;
        const restored = await this.request('PUT',this.userPath,{['uiPreferences.'+key]:this.preferences?.[key]??null},options);
        if (restored.status !== 200) throw new Error(`Preference restore returned ${restored.status}`);
      }
      const final = await this.request('GET',this.userPath,undefined,options);
      this.preferencesRestored = {ok:final.status===200&&isDeepStrictEqual(this.preferences,final.body.uiPreferences)};
      if (!this.preferencesRestored.ok) throw new Error('Account preferences differ after restoration');
    } catch (error) {this.preferencesRestored={ok:false,error:error.message};this.cleanupErrors.push(error.message);}
    await this.persist();
  }
}

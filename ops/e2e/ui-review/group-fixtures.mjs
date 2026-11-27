import {randomUUID} from 'node:crypto';
import {GROUP_SERVER} from '../rest/lib.mjs';

// Group identities are server-assigned. Persist a unique, verified-absent name before POST so a
// lost create reply can be reconciled and cleaned up without touching any pre-existing group.
export class ReviewGroups {
  constructor(request,persist){this.request=request;this.persist=persist;this.items=[];this.cleanupErrors=[];this.pending=new Set();this.closing=false;}
  call(method,path,body,options={}){return this.request(method,path,body,{...options,base:GROUP_SERVER});}
  create(label){
    if(this.closing)throw Error('Group fixture session is closing');
    const operation=this.createOwned(label);this.pending.add(operation);
    return operation.finally(()=>this.pending.delete(operation));
  }
  async createOwned(label){
    const name=`UI review ${label} ${randomUUID()}`;
    const before=await this.call('GET','/groups');
    if(before.status!==200||before.body.groups.some(g=>g['schema:name']===name))throw Error('Cannot establish absent group fixture');
    const item={name,id:null};this.items.push(item);await this.persist();
    const created=await this.call('POST','/groups',{'schema:name':name,'schema:description':'Temporary UI review group'});
    if(created.status!==201||!created.body['@id'])throw Error('Group fixture creation failed');
    item.id=created.body['@id'];await this.persist();return item;
  }
  owns(url){
    const parts=new URL(url).pathname.split('/').filter(Boolean);
    return parts[0]==='groups'&&this.items.some(item=>item.id===decodeURIComponent(parts[1]??''));
  }
  async close(){
    this.closing=true;await Promise.allSettled([...this.pending]);
    for(const item of [...this.items].reverse())try{
      if(!item.id){
        const listed=await this.call('GET','/groups');
        if(listed.status!==200)throw Error('Cannot reconcile pending group creation');
        const matches=listed.body.groups.filter(g=>g['schema:name']===item.name);
        if(matches.length>1)throw Error('Ambiguous pending group creation');
        item.id=matches[0]?.['@id']??null;await this.persist();
      }
      if(!item.id){item.absent=true;continue;}
      const path='/groups/'+encodeURIComponent(item.id),current=await this.call('GET',path);
      if(current.status!==404){
        const etag=current.headers?.get('etag');
        if(current.status!==200||!etag)throw Error('Cannot conditionally remove group fixture');
        const deleted=await this.call('DELETE',path,undefined,{headers:{'If-Match':etag}});
        if(![204,404].includes(deleted.status))throw Error('Group fixture deletion refused: '+deleted.status);
      }
      if((await this.call('GET',path)).status!==404)throw Error('Group fixture remains readable');
      item.absent=true;await this.persist();
    }catch(error){item.error=error.message;this.cleanupErrors.push(error.message);await this.persist();}
  }
}

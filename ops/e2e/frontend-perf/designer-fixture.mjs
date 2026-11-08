import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {hash, inventory, designerDelivery} from './lab.mjs';
import {template, standaloneFixtures} from './scenarios.mjs';

export const designerIds={small:'00000000-0000-4000-8000-000000000005',large:'00000000-0000-4000-8000-000000000100'};
export function apiFixtures(domain) {
  const replies={'/api/users/perf-user':{homeFolderId:'performance-home'}};
  for(const [size,id] of Object.entries(designerIds)) {
    const body=template(size==='small'?5:100);
    body['@id']=`https://repo.${domain}/templates/${id}`;
    replies['/api/templates/'+id]=body;
    replies['/api/templates/'+id+'/report']={currentUserPermissions:{capabilities:['updateResource']}};
  }
  return replies;
}

// Real HTTP responses preserve browser caching. Unknown routes/mutations are refused, never
// forwarded to a deployment. Authentication is deliberately outside this rendering benchmark.
export function designerApi(domain) {
  const replies=apiFixtures(domain);
  return async (req,res)=>{
    const url=new URL(req.url,'https://designer.'+domain);
    if (!url.pathname.startsWith('/api/')) return false;
    if (req.headers.host?.split(':')[0] !== 'resource.'+domain) {res.writeHead(404).end(); return true;}
    const cors={'Access-Control-Allow-Origin':`https://designer.${domain}`,'Access-Control-Expose-Headers':'ETag','Access-Control-Allow-Headers':'Authorization,CEDAR-Client-Session-Id,Accept','Access-Control-Allow-Methods':'GET'};
    if(req.method==='OPTIONS' && req.headers['access-control-request-method']==='GET') {res.writeHead(204,cors).end(); return true;}
    if(req.method !== 'GET') {res.writeHead(405).end(); return true;}
    const value=replies[url.pathname];
    if(!value) {res.writeHead(404).end(); return true;}
    const raw=Buffer.from(JSON.stringify(value)), gzip=/gzip/.test(req.headers['accept-encoding'] ?? '');
    const body=gzip?gzipSync(raw):raw;
    res.writeHead(200,{...cors,'Content-Type':'application/json','Content-Length':body.length,'Cache-Control':'no-store',
      'Vary':'Accept-Encoding',ETag:'"performance-fixture"',...(gzip?{'Content-Encoding':'gzip'}:{})});
    res.end(body);
    return true;
  };
}

export async function prepareDesigner(source,directory,domain) {
  const host=join(directory,'designer'), standalone=join(directory,'standalone');
  await cp(source,host,{recursive:true});
  const original=await inventory(host);
  // Verify the delivered component and host bundles before touching lab-only configuration.
  const integratedScript=await designerDelivery(host,domain);
  const hostManifest=JSON.parse(await readFile(join(host,'host/manifest.json'),'utf8'));
  for(const entry of Object.values(hostManifest)) {
    if(!/^host\/host\.(mjs|css)$/.test(entry.file) || hash(await readFile(join(host,entry.file)))!==entry.sha256)
      throw new Error('Designer host asset does not match its build manifest');
  }
  await mkdir(join(host,'config'),{recursive:true});
  const api=`https://resource.${domain}/api`;
  await writeFile(join(host,'config/host.json'),JSON.stringify({resourceRestAPI:api,userRestAPI:api,
    terminologyBaseUrl:api+'/terminology/',bridgeBaseUrl:api+'/bridge/',workspaceFrontend:`https://workspace.${domain}`}));
  await writeFile(join(host,'config/version.js'),`window.cedarDevelopmentMode=false;window.cedarCacheControl='performance-fixture';\nwindow.cedarHostAssets=${JSON.stringify(Object.fromEntries(Object.entries(hostManifest).map(([name,e])=>[name,`${e.file}?v=${e.sha256}`])))};\n`);
  const handler=join(host,'scripts/handlers/KeycloakUserHandler.js');
  // Keep the shipped adapter's parsing cost, then replace only the session boundary in this copy.
  await writeFile(handler,await readFile(handler,'utf8')+`\nwindow.KeycloakUserHandler=class {
    initUserHandler(ok){ok(true)} getParsedToken(){return {sub:'perf-user'}}
    getToken(){return 'performance-fixture'} refreshToken(_n,ok){return Promise.resolve(ok(true))}
    doLogin(){throw new Error('Unexpected login in rendering fixture')}
  };\n`);
  await mkdir(standalone);
  await standaloneFixtures(standalone,domain,integratedScript,['ced-integrated']);
  return {roots:{[`designer.${domain}`]:host,[`resource.${domain}`]:host,[`performance.${domain}`]:standalone},evidence:{
    sha256:original.sha256,original,served:await inventory(directory),apiSha256:hash(JSON.stringify(apiFixtures(domain))),
    adjustments:['Fixed HTTP API responses; no server writes or real SSO.',
      'Runtime config selects production caching and hashed host assets.',
      'Session adapter appended to the copied auth handler; shipped UI/host/components are unchanged.'],
  }};
}

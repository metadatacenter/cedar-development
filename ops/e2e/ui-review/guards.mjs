export function requireLocal(url) {
  const address=new URL(url);
  if(!['http:','https:'].includes(address.protocol)||(!['localhost','127.0.0.1'].includes(address.hostname)&&!address.hostname.endsWith('.metadatacenter.orgx')))
    throw new Error('UI review fixture writes require the local development deployment');
}
// These POSTs assess a submitted document; they do not mutate the repository.
export function readOnlyResourcePost(method,pathname) {
  return method==='POST'&&(/^\/artifact-validations\/[^/]+$/.test(pathname)||/^\/template-update-checks\/[^/]+$/.test(pathname));
}

// A new draft may be created only from an owned source, into an owned folder, at a new local
// identity that the caller supplied. The caller journals that identity before allowing the POST.
export function ownedDraftFixture(body,fixtures){
  const matches=(item,value)=>item.id===value||item.id.split('/').slice(-2).join('/')===value;
  const source=fixtures.find(item=>['templates','template-elements','template-fields'].includes(item.collection)&&matches(item,body?.['@id']));
  if(!source||!fixtures.some(item=>item.collection==='folders'&&matches(item,body?.folderId)))return null;
  try{
    const target=new URL(body.draftId),origin=new URL(source.id),parts=target.pathname.split('/').filter(Boolean);
    if(target.origin!==origin.origin||target.search||target.hash||parts.length!==2||parts[0]!==source.collection||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1]))return null;
    return {collection:source.collection,id:target.href};
  }catch{return null;}
}

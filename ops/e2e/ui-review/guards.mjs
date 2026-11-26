export function requireLocal(url) {
  const address=new URL(url);
  if(!['http:','https:'].includes(address.protocol)||(!['localhost','127.0.0.1'].includes(address.hostname)&&!address.hostname.endsWith('.metadatacenter.orgx')))
    throw new Error('UI review fixture writes require the local development deployment');
}
// These POSTs assess a submitted document; they do not mutate the repository.
export function readOnlyResourcePost(method,pathname) {
  return method==='POST'&&(/^\/artifact-validations\/[^/]+$/.test(pathname)||/^\/template-update-checks\/[^/]+$/.test(pathname));
}

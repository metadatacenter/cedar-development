// Keep enough context to distinguish an HTTP failure from a cancelled request or a navigation.
// Never retain headers, bodies, URL credentials, query strings or fragments in these diagnostics.
export function diagnosticUrl(value) {
  try {const url=new URL(value);return /^https?:$/.test(url.protocol)?url.origin+url.pathname:null;}catch{return null;}
}
function errorMetadata(value) {
  if(!value||typeof value!=='object')return null;
  const row={};
  for(const key of ['name','statusText'])if(typeof value[key]==='string')row[key]=value[key];
  if(typeof value.status==='number')row.status=value.status;
  if(typeof value.error?.type==='string')row.errorType=value.error.type;
  try{const url=new URL(value.url);if(/^https?:$/.test(url.protocol))row.url=url.origin+url.pathname;}catch{}
  return Object.keys(row).length?row:null;
}
export function browserDiagnostics(page,actions) {
  const networkFailures=[],navigations=[],pageErrors=[],pending=new Set();
  const context=()=>({at:new Date().toISOString(),actionCount:actions.length,
    lastAction:actions.at(-1)?.label??null,document:diagnosticUrl(page.url())});
  page.on('framenavigated',frame=>{
    if(frame===page.mainFrame())navigations.push({...context(),url:diagnosticUrl(frame.url())});
  });
  page.on('pageerror',error=>pageErrors.push({...context(),name:error.name,message:error.message}));
  page.on('requestfailed',request=>networkFailures.push({...context(),kind:'transport',
    method:request.method(),url:diagnosticUrl(request.url()),error:request.failure()?.errorText??null}));
  page.on('response',response=>{
    if(response.status()>=400)networkFailures.push({...context(),kind:'http',
      method:response.request().method(),url:diagnosticUrl(response.url()),status:response.status()});
  });
  return {networkFailures,navigations,pageErrors,context,
    enrich(message,row){
      const location=message.location();
      row.source={url:diagnosticUrl(location.url),line:location.lineNumber,column:location.columnNumber};
      const work=Promise.all(message.args().map(async handle=>{
        try{return await handle.evaluate(errorMetadata);}catch{return {unavailable:true};}
      })).then(values=>{row.errorObjects=values.filter(Boolean);});
      pending.add(work);void work.finally(()=>pending.delete(work));
    },
    async settle(){while(pending.size)await Promise.all([...pending]);},
  };
}

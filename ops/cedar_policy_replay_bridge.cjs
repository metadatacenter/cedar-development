// Read only: scalar verdicts from the current model bundle, one result per source row.
const {createInterface} = require('node:readline');
const {TextPolicy, IdentifierPolicy, TimestampPolicy, NumericPolicy, JsonSourcePolicy, RegexPolicy, REGEX_WORKER_SOURCE} = require(process.argv[2]);
const {Worker} = require('node:worker_threads');
const policy = new RegexPolicy({workerFactory() {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');
    globalThis.postMessage=(data)=>parentPort.postMessage(data);
    parentPort.on('message',(data)=>globalThis.onmessage({data}));\n${REGEX_WORKER_SOURCE}`, {eval:true});
  const result = {onmessage:null,onerror:null,postMessage:v=>worker.postMessage(v),terminate:()=>{void worker.terminate();}};
  worker.on('message',data=>result.onmessage?.({data}));
  worker.on('error',()=>result.onerror?.());
  return result;
}});
function decimalSignature(value) {
  const text = NumericPolicy.canonical(value);
  const [coefficient, power='0'] = text.toLowerCase().split('e');
  let digits = coefficient.replace('.','').replace(/^\+/,'');
  let exponent = BigInt(power) - BigInt((coefficient.split('.')[1]??'').length);
  const negative = digits.startsWith('-');
  digits = digits.replace(/^-?0*/,'');
  if (!digits) return '0e0';
  while (digits.endsWith('0')) {digits=digits.slice(0,-1);exponent++;}
  return (negative?'-':'')+digits+'e'+exponent;
}
(async () => {
  for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
    const {kind,value} = JSON.parse(line);
    let result;
    try {
      if (kind==='text') result=[TextPolicy.isBlank(value),TextPolicy.codePointLength(value)];
      else if(kind==='identifier') result=IdentifierPolicy.isValid(value);
      else if(kind==='timestamp') result=TimestampPolicy.canonical(value);
      else if(kind==='numeric') result=decimalSignature(value);
      else if(kind==='json-source') result=JsonSourcePolicy.stringify(JsonSourcePolicy.parse(value));
      else if(kind==='regex') {
        result=[await policy.evaluate(value)==='valid'];
        if(result[0]) for(const sample of ['ABC','abc','123','abc-123','é','😀','\u00a0','a\n'])
          result.push(await policy.evaluate(value,sample)==='match');
      } else throw new Error('Unknown policy');
    } catch {result=null;}
    process.stdout.write(JSON.stringify(result)+'\n');
  }
  policy.dispose();
})();

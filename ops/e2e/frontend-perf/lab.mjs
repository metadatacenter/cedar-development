import {createServer} from 'node:https';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {cp, mkdir, readFile, writeFile, readdir, stat, symlink, realpath} from 'node:fs/promises';
import {resolve, join, extname, sep} from 'node:path';
import {gzipSync} from 'node:zlib';

export const apps = {
  workspace: ['cedar-workspace', 'app'],
  designer: ['cedar-template-designer', 'app'],
  openview: ['cedar-openview/cedar-openview-src', 'dist/cedar-openview'],
  monitoring: ['cedar-monitoring/cedar-monitoring-src', 'dist/cedar-monitoring'],
  bridging: ['cedar-bridging/cedar-bridging-src', 'dist/cedar-bridging'],
  content: ['cedar-content-distribution', 'dist/cedar-content-distribution-src/browser'],
};
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function inventory(root) {
  const files = {};
  async function walk(path = '') {
    for (const entry of (await readdir(join(root, path), {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {const bytes = await readFile(join(root, name)); files[name] = {sha256:hash(bytes), bytes:bytes.length};}
    }
  }
  await walk();
  return {sha256:hash(JSON.stringify(files)), files};
}

async function command(executable, args, cwd, log) {
  const output = [];
  const child = spawn(executable, args, {cwd, env:{...process.env, NG_BUILD_MAX_WORKERS:'4'}});
  child.stdout.on('data', b => output.push(b)); child.stderr.on('data', b => output.push(b));
  const code = await new Promise((accept, reject) => {child.once('error', reject); child.once('close', accept);});
  await writeFile(log, Buffer.concat(output));
  if (code !== 0) throw new Error(`Production build failed (${code}); see ${log}`);
}

// Copies/builds into the report directory. Never restarts, installs into or edits a checkout.
export async function prepare(home, directory, domain) {
  await mkdir(directory, {recursive:true});
  const runtime = JSON.parse(await readFile(join(home, '.reactor/runtime.json'), 'utf8'));
  const roots = {}, evidence = {reactor:runtime, sources:{}, outputs:{}, domain, adjustments:[]};
  for (const [name, [repo, output]] of Object.entries(apps)) {
    const source = join(home, repo), target = join(directory, name);
    evidence.sources[name] = {repository:repo,
      revision:execFileSync('git', ['rev-parse', 'HEAD'], {cwd:source,encoding:'utf8'}).trim(),
      status:execFileSync('git', ['status','--porcelain'], {cwd:source,encoding:'utf8'}).trim()};
    console.log(`Preparing production ${name}`);
    if (['openview','monitoring','bridging','content'].includes(name)) {
      // The normal production configuration, with only the deployment domain parameter changed.
      // Production targets .org; using that unchanged would authenticate against production.
      const copy = join(directory, 'sources', name);
      await cp(source, copy, {recursive:true, filter:path => !path.slice(source.length).split(sep).some(p =>
        ['node_modules','.git','dist','.angular','browser','test-results'].includes(p))});
      await symlink(join(source, 'node_modules'), join(copy, 'node_modules'), 'dir');
      if (name !== 'content') {
        const env = join(copy, 'src/environments/environment.production.ts');
        const before = await readFile(env, 'utf8');
        if (!/cedarDomain:\s*'metadatacenter.org'/.test(before)) throw new Error(`Unrecognized production domain in ${env}`);
        await writeFile(env, before.replace(/cedarDomain:\s*'metadatacenter.org'/, `cedarDomain: '${domain}'`));
        evidence.adjustments.push({application:name,file:'src/environments/environment.production.ts',change:'Local deployment domain only'});
      }
      await command(process.execPath, [join(source, 'node_modules/@angular/cli/bin/ng.js'), 'build', '--configuration=production'],
        copy, join(directory, `${name}-build.log`));
      await cp(join(copy, output), target, {recursive:true});
    } else {
      await cp(join(source, output), target, {recursive:true});
      // Native Workspace also uses ng build's default production configuration.
      if (name === 'workspace' && !(await readFile(join(target,'workspace-build/index.html'),'utf8')).includes('workspace-build/main-'))
        throw new Error('Workspace has no staged production build; run cedarcli build frontends');
      // Native config adds Date.now() to component URLs in development mode. Keep the
      // compiled production bundles unchanged, but select server cache behavior in this copy.
      const version = join(target,'config/version.js');
      const before = await readFile(version,'utf8');
      if (!/window\.cedarDevelopmentMode\s*=\s*(true|false);/.test(before)) throw new Error('Missing development-mode configuration: '+version);
      await writeFile(version,before.replace(/window\.cedarDevelopmentMode\s*=\s*(true|false);/,'window.cedarDevelopmentMode = false;'));
      evidence.adjustments.push({application:name,file:'config/version.js',change:'Server cache behavior; disable development URL cache busting'});
    }
    roots[`${name}.${domain}`] = target;
    evidence.outputs[name] = await inventory(target);
  }
  const componentRoot = join(directory, 'standalone');
  await mkdir(componentRoot, {recursive:true});
  for (const [short, repo] of [['cee','cedar-embeddable-editor'], ['ced','cedar-embeddable-designer'], ['cetp','cedar-embeddable-term-picker']]) {
    const artifact = join(home, '.reactor/artifacts', runtime.packages[repo] + '.tgz');
    if (hash(await readFile(artifact)) !== runtime.packages[repo]) throw new Error(`Artifact hash mismatch: ${repo}`);
    const bundle = execFileSync('tar', ['-xOf', artifact, `package/${repo}.js`], {maxBuffer:20*1024*1024});
    await writeFile(join(componentRoot, short + '.js'), bundle);
  }
  roots[`performance.${domain}`] = componentRoot;
  const integratedScript = await designerDelivery(join(directory,'designer'),domain);
  evidence.outputs.standalone = await inventory(componentRoot);
  await writeFile(join(directory,'artifacts.json'), JSON.stringify(evidence,null,2)+'\n');
  return {roots, evidence, componentRoot, integratedScript};
}

export async function designerDelivery(directory,domain) {
  // The equivalent CED fixture uses precisely the host's shared CEE/CEF, CETP and CED bytes.
  const manifest = JSON.parse(await readFile(join(directory, 'components/manifest.json'), 'utf8'));
  const deliveries = ['cedar-embeddable-editor','cedar-embeddable-term-picker','cedar-embeddable-designer']
    .map(name => manifest[name]?.delivery);
  const delivery = deliveries[0];
  if (!delivery || !/^[a-zA-Z0-9-]+\.js$/.test(delivery.file) ||
      deliveries.some(item => item?.file !== delivery.file || item?.sha256 !== delivery.sha256) ||
      hash(await readFile(join(directory,'components',delivery.file))) !== delivery.sha256)
    throw new Error('Equivalent CED benchmark requires one verified shared Designer component bundle');
  return `https://designer.${domain}/components/${delivery.file}?v=${delivery.sha256}`;
}

const mime = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.woff':'font/woff', '.png':'image/png', '.ico':'image/x-icon'};

// A browser-private HTTPS origin mapping preserves the apps' real origins and SSO redirect URIs.
// No Playwright request routing: it would disable the HTTP cache being measured.
export async function serve(roots, directory, respond) {
  const key = join(directory,'lab-key.pem'), cert = join(directory,'lab-cert.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=CEDAR performance lab'], {stdio:'ignore'});
  const cache = new Map();
  const server = createServer({key:await readFile(key), cert:await readFile(cert)}, async (req,res) => {
    try {
      const root = roots[req.headers.host?.split(':')[0]];
      if (!root) {res.writeHead(404).end(); return;}
      if (respond && await respond(req,res)) return;
      if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405).end(); return;}
      const path = decodeURIComponent(new URL(req.url,'https://lab').pathname);
      if (path.includes('\\') || path.includes('\0') || path.split('/').some(p => p.startsWith('.'))) {res.writeHead(403).end(); return;}
      let file = resolve(root, '.' + path);
      if (!file.startsWith(root + sep)) file = join(root,'index.html');
      try {if (!(await stat(file)).isFile()) file = join(file,'index.html'); await stat(file);}
      catch {if (extname(path)) {res.writeHead(404).end(); return;} file = join(root,'index.html');}
      if (!(await realpath(file)).startsWith((await realpath(root)) + sep)) {res.writeHead(403).end(); return;}
      if (!cache.has(file)) {
        const raw = await readFile(file);
        cache.set(file, {raw, gzip:gzipSync(raw), etag:'"'+hash(raw)+'"'});
      }
      const asset = cache.get(file), type = mime[extname(file)] ?? 'application/octet-stream';
      const compress = /gzip/.test(req.headers['accept-encoding'] ?? '') && /text|json|svg/.test(type);
      const body = compress ? asset.gzip : asset.raw;
      res.writeHead(200, {'Content-Type':type, 'Content-Length':body.length, 'Vary':'Accept-Encoding',
        'Cache-Control':extname(file) === '.html' ? 'no-store' : 'public, max-age=3600', ETag:asset.etag,
        ...(/\.woff2?$/.test(file) ? {'Access-Control-Allow-Origin':'*'} : {}),
        ...(compress ? {'Content-Encoding':'gzip'} : {})});
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {res.writeHead(404).end();}
  });
  await new Promise((accept,reject) => {server.once('error',reject); server.listen(0,'127.0.0.1',accept);});
  return {server, rules:Object.keys(roots).map(host => `MAP ${host} 127.0.0.1:${server.address().port}`).join(', ')};
}

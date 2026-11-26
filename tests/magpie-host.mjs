import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const magpie = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'Programs/magpie/magpie.exe');
const bun = await realpath(process.argv[3] || path.join(root, '.local-tools/node_modules/@oven/bun-windows-x64/bin/bun.exe'));
const parent = path.join(root, '.sandbox');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, 'host-'));
const home = path.join(directory, 'home');
const config = path.join(directory, 'config/magpie');
const fixture = path.join(directory, 'fixture');
const captures = [];
const userAgents = [];
const sentModels = [];
const sentEfforts = [];
const sentBudgets = [];
let mode = 'pass';
let disconnected = false;
let limited = 0;
let listRequests = 0;
const upstream = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') { listRequests++; res.writeHead(401); return res.end(); }
  if (req.url === '/api/user/self') {
    if (req.headers.authorization !== 'fixture-site-token' || req.headers['new-api-user'] !== '42') { res.writeHead(401); return res.end(); }
    return res.end(JSON.stringify({success:true,data:{quota:'625000',used_quota:250000}}));
  }
  if (req.headers.authorization !== 'Bearer fixture-only' || req.headers['new-api-user']) { res.writeHead(403); return res.end(); }
  if (mode === 'unauthorized') { res.writeHead(401,{'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:'Invalid API key',code:'invalid_api_key'}})); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  if (text.includes('_ag_relay_request')) { res.writeHead(400); return res.end('internal request marker leaked'); }
  captures.push({ caller: req.headers['fixture-caller'], enabled: req.headers['fixture-enabled'], path: req.url });
  userAgents.push(req.headers['user-agent']);
  sentBudgets.push(Number(req.headers['fixture-budget']));
  if (mode === 'hang') { res.once('close', () => { disconnected = true; }); return; }
  if (mode === 'rate' || (mode === 'recover' && ++limited <= 2)) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
    return res.end(JSON.stringify({ error: { message: 'Too many requests', code: 'rate_limit_exceeded' } }));
  }
  if (req.url !== '/v1/responses') { res.writeHead(404); return res.end(); }
  const {model,stream,reasoning} = JSON.parse(text);
  sentModels.push(model);
  sentEfforts.push(reasoning?.effort);
  if (!['gpt-6.1-sol','future-known-fixture','fixture-model'].includes(model)) { res.writeHead(400); return res.end(); }
  const item = { id:'msg_fixture',type:'message',role:'assistant',content:[{type:'output_text',text:'fixture OK'}] };
  const response = {id:'resp_fixture',object:'response',status:'completed',model,output:[item]};
  if (stream) {
    res.writeHead(200,{'content-type':'text/event-stream','x-request-id':'fixture-stream'});
    const events = [
      {type:'response.created',response:{...response,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...item,content:[]}},
      {type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:''}},
      {type:'response.output_text.delta',output_index:0,content_index:0,delta:'fixture OK'},
      {type:'response.output_item.done',output_index:0,item}, {type:'response.completed',response},
    ];
    return res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response));
});
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
const fixturePort = await listen(upstream);
const reservation = http.createServer();
const port = await listen(reservation);
const webReservation = http.createServer();
const web = `http://127.0.0.1:${await listen(webReservation)}`;
await new Promise(resolve => webReservation.close(resolve));
await new Promise(resolve => reservation.close(resolve));
const addr = `127.0.0.1:${port}`;
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, SystemDrive: process.env.SystemDrive, COMSPEC: process.env.COMSPEC,
  PATH: path.join(process.env.SystemRoot, 'System32'), HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming'),
  TEMP: directory, TMP: directory, XDG_CONFIG_HOME: path.dirname(config), XDG_CACHE_HOME: path.join(directory,'cache'), XDG_DATA_HOME: path.join(directory,'data'), XDG_STATE_HOME: path.join(directory,'state'), MAGPIE_BIN_DIR: path.join(directory,'bin'), MAGPIE_BUN: bun, MAGPIE_ADDR: addr, MAGPIE_PLUGIN_MARKET: 'off', DO_NOT_TRACK: '1' };
const cli = async (...args) => (await promisify(execFile)(magpie, args, { cwd: directory, env, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 })).stdout;
env.MAGPIE_WEB_KEY = randomUUID();
const json = (file, data) => writeFile(file, JSON.stringify(data));
let gateway, ended, log = '';
try {
  for (const dir of [config, fixture, home, env.LOCALAPPDATA, env.APPDATA]) await mkdir(dir, { recursive: true });
  assert.ok((await cli('data')).includes(config));
  const artifact = process.argv[4];
  if (artifact) {
    await promisify(execFile)('tar.exe',['-xf',path.resolve(artifact),'--strip-components','1','-C',fixture]);
    await cli('plugin','add',fixture);
    const manifest = JSON.parse(await readFile(path.join(fixture,'package.json'),'utf8'));
    const initial = JSON.parse(await cli('plugin','--json'));
    assert.ok(initial.providers?.some(entry => entry.id === 'agentrouter-relay'));
    console.log(`PASS: unmodified ${manifest.version} archive loads without credentials`);
  } else {
    for (const file of ['lib','ui','package.json','relay.middleware.mjs']) await cp(path.join(root,file),path.join(fixture,file),{recursive:true});
  }
  await writeFile(path.join(fixture,'provider.mjs'), `import {createProvider} from './lib/provider.mjs'; import {createTransport} from './lib/transport.mjs'; const relay=createTransport(fetch,{maxAttempts:3}); export default createProvider('http://127.0.0.1:${fixturePort}/v1', (request, context) => { request.headers.set('fixture-caller',context.caller); request.headers.set('fixture-enabled',String(context.retryRateLimit)); request.headers.set('fixture-budget',String(context.retryBudgetMs)); return relay(request,context); });`);
  await json(path.join(config,'settings.json'), { sessionReads: { asked:true, all:false, agents:{} } });
  const catalogDir = path.join(env.XDG_CACHE_HOME,'magpie');
  await mkdir(catalogDir,{recursive:true});
  const levels = {'gpt-6.1-sol':['low','medium','high','xhigh','max'],'future-known-fixture':['low','high']};
  await json(path.join(catalogDir,'models.json'),{openai:{id:'openai',models:Object.fromEntries(Object.entries(levels).map(([id,values])=>[id,{id,reasoning:true,reasoning_options:[{type:'effort',values}]}]))}});
  await json(path.join(config,'providers.json'), {providers:[{id:'agentrouter-relay',models:['gpt-6.1-sol','fixture-model','future-known-fixture']}]});
  await cli('plugin','add',fixture);
  gateway = spawn(magpie,['serve',`--web=${new URL(web).host}`], { cwd:directory, env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  ended = once(gateway,'close');
  for (const stream of [gateway.stdout,gateway.stderr]) stream.on('data',chunk => { log = (log + chunk).slice(-3000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await (await fetch(`http://${addr}`, { signal:AbortSignal.timeout(300) })).text(); break; } catch { await delay(100); }
    assert.equal(gateway.exitCode,null,log);
  }
  const login = await fetch(`${web}/?k=${env.MAGPIE_WEB_KEY}`,{ redirect:'manual' });
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie,'Isolated settings page did not establish a session');
  const signin = async (suffix, fields) => {
    const response = await fetch(`${web}/api/plugin-signin${suffix}`,{method:'POST',headers:{cookie,origin:web,'content-type':'application/json'},body:JSON.stringify({provider:'agentrouter-relay',method:1,...fields})});
    const text = await response.text();
    assert.equal(response.status,200,text);
    return JSON.parse(text);
  };
  assert.equal((await signin('',{method:0,key:'fixture-only'})).state,'done');
  assert.equal(listRequests,0,'API Key sign-in must not prefetch /v1/models');
  const codexList = await fetch(`http://${addr}/v1/codex/models?client_version=0.167.0`);
  assert.equal(codexList.status,200);
  const {models: picker} = await codexList.json();
  for (const [model,values] of Object.entries(levels)) {
    const entry = picker.find(row=>row.slug===`agentrouter-relay/${model}`);
    for (const value of values) assert.ok(entry?.supported_reasoning_levels?.some(row=>row.effort===value),`${model} missing ${value} in Codex picker: ${JSON.stringify(entry?.supported_reasoning_levels)}`);
  }
  const unknown = picker.find(row=>row.slug==='agentrouter-relay/fixture-model');
  assert.ok(unknown?.supported_reasoning_levels?.some(row=>row.effort==='high'),'A manually added unknown model should use Magpie’s Codex defaults');
  for (const [model,effort] of [['gpt-6.1-sol','xhigh'],['future-known-fixture','high'],['fixture-model','high'],['fixture-model',undefined]]) {
    const reply = await fetch(`http://${addr}/v1/responses`,{method:'POST',headers:{'content-type':'application/json','user-agent':'codex_cli_rs/1.0'},body:JSON.stringify({model:`agentrouter-relay/${model}`,input:'fixture',...(effort ? {reasoning:{effort}} : {})}),signal:AbortSignal.timeout(15000)});
    assert.equal(reply.status,200,await reply.text());
    assert.equal(sentModels.at(-1),model);
    assert.equal(sentEfforts.at(-1),effort,`${model}: upstream reasoning effort`);
  }
  console.log('PASS: Magpie model efforts for declared and manually added models; selected and default requests on the wire');
  for (const [model,ua] of [['gpt-6.1-sol','Mozilla/5.0 Claude/fixture'],['fixture-model','claude-cli/1.0']]) {
    const before = captures.length;
    const messages = await fetch(`http://${addr}/v1/messages`,{method:'POST',headers:{'content-type':'application/json','anthropic-version':'2023-06-01','user-agent':ua},body:JSON.stringify({model:`agentrouter-relay/${model}`,max_tokens:64,messages:[{role:'user',content:'fixture'}]}),signal:AbortSignal.timeout(15000)});
    const text = await messages.text();
    assert.equal(messages.status,200,text);
    assert.match(text,/fixture OK/);
    assert.equal(JSON.parse(text).content[0].text,'fixture OK');
    assert.equal(sentModels.at(-1),model);
    assert.deepEqual(captures.slice(before),[{caller:'claude',enabled:'true',path:'/v1/responses'}]);
    assert.equal(userAgents.at(-1),ua);
  }
  console.log('PASS: plain API key, Claude Messages to Responses, declared and hand-entered model IDs');
  let step = await signin('/prompt',{inputs:{}});
  for (const [key,value] of [['modelKey','fixture-only'],['userId','42'],['balanceToken','fixture-site-token']]) {
    assert.equal(step.prompt?.key,key);
    step = await signin('/prompt',{inputs:step.inputs,key,value});
  }
  assert.ok(!step.prompt);
  assert.equal((await signin('',{inputs:step.inputs})).state,'done');
  const listed = JSON.parse(await cli('plugin','--json'));
  const added = listed.providers?.find(provider => provider.id === 'agentrouter-relay');
  assert.equal(added?.models?.find(model => model.id === 'gpt-6.1-sol')?.reasoning,true);
  assert.equal(added.options.find(option => option.key === 'retry-rate-limit')?.default, true);
  assert.equal(added.options.find(option => option.key === 'forward-client-ua')?.default, true);
  const quota = await cli('quota','agentrouter-relay','--json');
  assert.match(quota,/\$1\.25/,'Expected the fixture account balance via the Magpie quota interface');
  assert.match(quota,/\$0\.50/,'Expected the cumulative spend as a separate reading');
  console.log('PASS: Magpie reports the isolated account balance using the separate site credential');
  const post = (ua, signal = AbortSignal.timeout(15000)) => fetch(`http://${addr}/v1/responses`, { method:'POST', headers:{ 'content-type':'application/json','user-agent':ua }, body:JSON.stringify({ model:'agentrouter-relay/fixture-model',input:[{role:'user',content:'fixture'}],stream:false }), signal });
  for (const [agent,ua] of [['codex','codex_cli_rs/1.0'],['claude','claude-cli/1.0']]) {
    const before = captures.length;
    const response = await post(ua);
    assert.equal(response.status,200,await response.text());
    assert.deepEqual(captures.slice(before),[{ caller:agent, enabled:'true', path:'/v1/responses' }]);
    assert.equal(userAgents.at(-1),ua);
    console.log(`PASS: ${agent} Responses, one upstream attempt`);
  }
  const generic = await post('magpie/0.1.4777');
  assert.equal(generic.status,200,await generic.text());
  assert.equal(userAgents.at(-1),'magpie/0.1.4777');
  const streamed = await fetch(`http://${addr}/v1/responses`,{method:'POST',headers:{'content-type':'application/json','user-agent':'codex_cli_rs/1.0'},body:JSON.stringify({model:'agentrouter-relay/fixture-model',input:'fixture',stream:true}),signal:AbortSignal.timeout(15000)});
  assert.equal(streamed.status,200);
  assert.match(await streamed.text(),/fixture OK/);
  assert.equal(streamed.headers.get('x-request-id'),'fixture-stream');
  mode = 'recover';
  const beforeRecover = captures.length;
  const recovered = await post('codex_cli_rs/1.0');
  assert.equal(recovered.status,200,await recovered.text());
  assert.equal(captures.length-beforeRecover,3);
  assert.deepEqual(userAgents.slice(beforeRecover),Array(3).fill('codex_cli_rs/1.0'));
  console.log('PASS: two rate limits then success, three actual sends');
  mode = 'rate';
  const beforeCap = captures.length;
  const exhausted = await post('codex_cli_rs/1.0',AbortSignal.timeout(95000));
  assert.equal(exhausted.status,429,await exhausted.text());
  assert.equal(captures.length-beforeCap,3,'The host reopened the plugin budget or did not load the middleware');
  console.log('PASS: persistent 429 across host retries, exactly three sends for cap=3');
  const beforeCancel = captures.length;
  mode = 'hang';
  const controller = new AbortController();
  const pending = post('codex_cli_rs/1.0',controller.signal).then(response => response.text()).catch(() => {});
  try {
    for (let attempts = 0; captures.length === beforeCancel && attempts < 80; attempts++) await delay(50);
    assert.equal(captures.length,beforeCancel+1);
  } finally { controller.abort(); await pending; }
  for (let attempts = 0; !disconnected && attempts < 80; attempts++) await delay(50);
  assert.ok(disconnected,'Cancelling the client did not disconnect the fixture');
  console.log('PASS: client cancellation closed the upstream request');
  const save = await fetch(`${web}/api/settings/plugin-option`, { method:'POST', headers:{ cookie,origin:web,'content-type':'application/json' },body:JSON.stringify({provider:'agentrouter-relay',key:'retry-rate-limit',on:false}) });
  assert.equal(save.status,200,await save.text());
  mode = 'pass';
  const switched = await post('codex_cli_rs/1.0');
  assert.equal(switched.status,200,await switched.text());
  assert.equal(captures.at(-1).enabled,'false');
  console.log('PASS: option updated without restarting the gateway');
  const uaSave = await fetch(`${web}/api/settings/plugin-option`,{method:'POST',headers:{cookie,origin:web,'content-type':'application/json'},body:JSON.stringify({provider:'agentrouter-relay',key:'forward-client-ua',on:false})});
  assert.equal(uaSave.status,200,await uaSave.text());
  const uaOff = await post('codex_cli_rs/fixture-disabled');
  assert.equal(uaOff.status,200,await uaOff.text());
  assert.notEqual(userAgents.at(-1),'codex_cli_rs/fixture-disabled');
  mode = 'rate';
  const beforeRate = captures.length;
  const rejected = await post('codex_cli_rs/1.0', AbortSignal.timeout(95000)).catch(error => { throw new Error(`Host rate-limit check (${captures.length-beforeRate} actual sends): ${error.message}`); });
  const body = await rejected.text();
  assert.equal(rejected.status,429,`${captures.length-beforeRate} actual sends: ${body}`);
  assert.equal(captures.length-beforeRate,3,'Delegated host retries must also respect the shared cap');
  assert.ok(captures.slice(beforeRate).every(row => row.enabled === 'false'));
  console.log(`HOST: switch off, HTTP 429, ${captures.length-beforeRate} actual upstream sends`);
  assert.equal(listRequests,0,'No upstream model list needed throughout this run');
  const panelsResponse = await fetch(`${web}/api/plugin-panels`,{headers:{cookie}});
  assert.equal(panelsResponse.status,200);
  const panels = await panelsResponse.json();
  const panel = panels.find(row=>row.slot==='settings' && row.name==='magpie-agentrouter-relay');
  assert.ok(panel,'Settings panel should be listed by Magpie');
  const panelHtml = await fetch(`${web}${panel.url}`,{headers:{cookie}});
  assert.equal(panelHtml.status,200);
  assert.match(await panelHtml.text(),/retry-budget/);
  const saveBudget = await fetch(`${web}/api/plugin-pages/options`,{method:'POST',headers:{cookie,origin:web,'content-type':'application/json'},body:JSON.stringify({spec:panel.spec,options:{retryBudgetSeconds:60,fixtureOption:'preserve'}})});
  assert.equal(saveBudget.status,200,await saveBudget.text());
  mode = 'pass';
  const budgetReply = await post('codex_cli_rs/1.0');
  assert.equal(budgetReply.status,200,await budgetReply.text());
  assert.equal(sentBudgets.at(-1),60000);
  console.log('PASS: settings panel is served and saved options reach subsequent requests');
  if (process.argv.includes('--inspect-ui')) {
    await json(path.join(parent,'panel-review.json'),{url:`${web}/?k=${env.MAGPIE_WEB_KEY}`,directory});
    console.log('UI_REVIEW: press Enter after inspecting the provider panel');
    await once(process.stdin,'data');
    process.stdin.pause();
    const pluginOptions = JSON.parse(await readFile(path.join(config,'plugins.json'),'utf8')).plugins.find(row=>row.spec===panel.spec).options;
    assert.equal(pluginOptions.fixtureOption,'preserve');
    assert.equal(pluginOptions.retryBudgetSeconds,120);
    const panelReply = await post('codex_cli_rs/1.0');
    assert.equal(panelReply.status,200,await panelReply.text());
    assert.equal(sentBudgets.at(-1),120000);
    console.log('PASS: panel saves preserve other options and affect the next request');
  }
  mode = 'unauthorized';
  const denied = await post('codex_cli_rs/1.0');
  assert.equal(denied.status,401,await denied.text());
  const accountState = async () => JSON.parse(await readFile(path.join(config,'logins.json'),'utf8')).find(row=>row.agent==='plugin:agentrouter-relay');
  assert.ok((await accountState())?.lapsed,'A model key rejected by the upstream must be marked');
  assert.match(await cli('quota','agentrouter-relay','--json'),/\$1\.25/);
  assert.ok((await accountState())?.lapsed,'A successful site balance read must not clear the rejected model key');
  console.log('PASS: site balance and model key sign-in state remain independent');
} finally {
  if (gateway && gateway.exitCode === null) gateway.kill();
  if (ended) await ended;
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  assert.equal(path.dirname(await realpath(directory)),await realpath(parent));
  await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}

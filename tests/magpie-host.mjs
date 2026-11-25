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
let mode = 'pass';
let disconnected = false;
let limited = 0;
const upstream = http.createServer(async (req, res) => {
  if (req.url === '/api/user/self') {
    if (req.headers.authorization !== 'fixture-site-token' || req.headers['new-api-user'] !== '42') { res.writeHead(401); return res.end(); }
    return res.end(JSON.stringify({success:true,data:{quota:625000}}));
  }
  if (req.headers.authorization !== 'Bearer fixture-only' || req.headers['new-api-user']) { res.writeHead(403); return res.end(); }
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture-model', supported_endpoint_types:['openai-response','anthropic'] }, { id:'fixture-native', supported_endpoint_types:['anthropic'] }] }));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  if (text.includes('_ag_relay_request')) { res.writeHead(400); return res.end('internal request marker leaked'); }
  captures.push({ caller: req.headers['fixture-caller'], enabled: req.headers['fixture-enabled'], path: req.url });
  userAgents.push(req.headers['user-agent']);
  if (mode === 'hang') { res.once('close', () => { disconnected = true; }); return; }
  if (mode === 'rate' || (mode === 'recover' && ++limited <= 2)) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
    return res.end(JSON.stringify({ error: { message: 'Too many requests', code: 'rate_limit_exceeded' } }));
  }
  if (new URL(req.url,'http://localhost').pathname === '/v1/messages') {
    res.writeHead(200, { 'content-type':'text/event-stream' });
    const events = [
      {type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:'fixture-native',content:[],usage:{input_tokens:1,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fixture OK'}},
      {type:'content_block_stop',index:0}, {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}}, {type:'message_stop'},
    ];
    return res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'resp_fixture', object: 'response', status: 'completed', model: 'fixture-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture OK' }] }] }));
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
    for (const file of ['lib','package.json','relay.middleware.mjs']) await cp(path.join(root,file),path.join(fixture,file),{recursive:true});
  }
  await writeFile(path.join(fixture,'provider.mjs'), `import {createProvider} from './lib/provider.mjs'; import {createTransport} from './lib/transport.mjs'; const relay=createTransport(fetch,{maxAttempts:3}); export default createProvider('http://127.0.0.1:${fixturePort}/v1', (request, context) => { request.headers.set('fixture-caller',context.caller); request.headers.set('fixture-enabled',String(context.retryRateLimit)); return relay(request,context); });`);
  await json(path.join(config,'settings.json'), { sessionReads: { asked:true, all:false, agents:{} } });
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
  let step = await signin('/prompt',{inputs:{}});
  for (const [key,value] of [['modelKey','fixture-only'],['userId','42'],['balanceToken','fixture-site-token']]) {
    assert.equal(step.prompt?.key,key);
    step = await signin('/prompt',{inputs:step.inputs,key,value});
  }
  assert.ok(!step.prompt);
  assert.equal((await signin('',{inputs:step.inputs})).state,'done');
  const listed = JSON.parse(await cli('plugin','--json'));
  const added = listed.providers?.find(provider => provider.id === 'agentrouter-relay');
  assert.ok(added?.models?.some(model => model.id === 'fixture-model'), `Provider discovery: ${JSON.stringify(listed).slice(0,1500)}`);
  assert.ok(added.models.find(model => model.id === 'fixture-model')?.also?.includes('@ai-sdk/anthropic'), JSON.stringify(added.models));
  assert.equal(added.options.find(option => option.key === 'retry-rate-limit')?.default, true);
  const quota = await cli('quota','agentrouter-relay','--json');
  assert.match(quota,/\$1\.25/,'Expected the fixture account balance via the Magpie quota interface');
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
  const beforeMessages = captures.length;
  const messages = await fetch(`http://${addr}/v1/messages`,{ method:'POST',headers:{'content-type':'application/json','anthropic-version':'2023-06-01','user-agent':'claude-cli/1.0'},body:JSON.stringify({model:'agentrouter-relay/fixture-native',max_tokens:64,messages:[{role:'user',content:'fixture'}]}),signal:AbortSignal.timeout(15000) });
  const messageText = await messages.text();
  assert.equal(messages.status,200,`${JSON.stringify(captures.slice(beforeMessages))} ${messageText}`);
  assert.match(messageText,/fixture OK/);
  assert.deepEqual(captures.slice(beforeMessages),[{caller:'claude',enabled:'true',path:'/v1/messages'}]);
  assert.equal(userAgents.at(-1),'claude-cli/1.0');
  console.log('PASS: native Claude Messages reached /v1/messages');
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
  mode = 'rate';
  const beforeRate = captures.length;
  const rejected = await post('codex_cli_rs/1.0', AbortSignal.timeout(95000)).catch(error => { throw new Error(`Host rate-limit check (${captures.length-beforeRate} actual sends): ${error.message}`); });
  const body = await rejected.text();
  assert.equal(rejected.status,429,`${captures.length-beforeRate} actual sends: ${body}`);
  assert.equal(captures.length-beforeRate,3,'Delegated host retries must also respect the shared cap');
  assert.ok(captures.slice(beforeRate).every(row => row.enabled === 'false'));
  console.log(`HOST: switch off, HTTP 429, ${captures.length-beforeRate} actual upstream sends`);
} finally {
  if (gateway && gateway.exitCode === null) gateway.kill();
  if (ended) await ended;
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  assert.equal(path.dirname(await realpath(directory)),await realpath(parent));
  await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}

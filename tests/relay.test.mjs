import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createTransport } from '../lib/transport.mjs';
import { onProvider } from '../relay.middleware.mjs';
import { readBalance, balanceMethod } from '../lib/balance.mjs';

const ok = () => Response.json({ object:'response', output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}] });
const error = (status, code, message, headers) => Response.json({error:{code,message}},{status,headers});
const limit = () => error(429,'rate_limit_exceeded','Too many requests');
const rateJSON = () => error(200,'rate_limit_exceeded','Too many requests');
const asEvents = (...events) => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
const started = {type:'response.created',response:{id:'resp_test'}};
const rateEvent = {type:'error',error:{code:'rate_limit_exceeded',message:'too many requests'}};
const textEvent = {type:'response.output_text.delta',delta:'visible'};
const toolEvent = {type:'response.output_item.added',item:{type:'function_call',name:'charge',call_id:'call_x'}};
const done = {type:'response.completed',response:{status:'completed',output:[]}};
const modelBody = { model:'fixture',input:[{role:'user',content:'hello'}],prompt_cache_key:'cache-original' };
function client(body, tag, signal) {
  return new Request('https://example.invalid/v1/responses',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify({...body,...(tag ? {_ag_relay_request:tag} : {})}),signal});
}
function fixture(replies, cap=4) {
  const sent = [];
  const run = createTransport(async (url,init) => {
    const body = JSON.parse(Buffer.from(init.body).toString());
    sent.push({body,headers:init.headers,path:new URL(url).pathname});
    return replies[Math.min(sent.length-1,replies.length-1)]();
  },{maxAttempts:cap,baseDelayMs:1,maxDelayMs:1});
  const tag = randomUUID();
  return {sent, ask:(body=modelBody,options={}) => run(client(body,options.untagged ? null : [tag,options.round ?? 1],options.signal),{caller:options.caller ?? 'codex',retryRateLimit:options.enabled ?? true})};
}

test('middleware marks only the selected provider; two clients receive independent envelopes',() => {
  const ctx={provider:{id:'agentrouter-relay'},state:{}};
  const other={provider:{id:'elsewhere'},state:{}};
  assert.equal(onProvider(modelBody,other),undefined);
  const first = onProvider(modelBody,ctx)._ag_relay_request;
  assert.deepEqual(onProvider(modelBody,ctx)._ag_relay_request,[first[0],2]);
  assert.notEqual(onProvider(modelBody,{...ctx,state:{}})._ag_relay_request[0],first[0]);
  assert.ok(!Object.hasOwn(modelBody,'_ag_relay_request'));
});

for (const [name,limited] of [['HTTP 429',limit],['JSON 200',rateJSON],['SSE 200',()=>asEvents(started,rateEvent)]]) {
  test(`${name}: temporary rate recovered without changing history or cache key`,async () => {
    const run=fixture([limited,ok]);
    assert.equal((await run.ask()).status,200);
    assert.deepEqual(run.sent.map(entry=>entry.body),[modelBody,modelBody]);
  });
  test(`${name}: switch off delegates one attempt and preserves a 429`,async () => {
    const run=fixture([limited]);
    assert.equal((await run.ask(modelBody,{enabled:false})).status,429);
    assert.equal(run.sent.length,1);
  });
}

test('persistent rate, duplicate host callbacks, untagged requests and stale rounds',async () => {
  const run=fixture([limit],3);
  for(const round of [1,1,2,3]) assert.equal((await run.ask(modelBody,{round})).status,429);
  assert.equal(run.sent.length,3);
  const missing=fixture([limit],3);
  assert.equal((await missing.ask(modelBody,{round:2})).status,503);
  assert.equal(missing.sent.length,0);
  assert.equal((await missing.ask(modelBody,{untagged:true})).status,429);
  assert.equal(missing.sent.length,1);
});

test('quota and key rejection do not retry; long Retry-After does not start another send',async () => {
  for(const [reply,code] of [[()=>error(429,'insufficient_quota','budget pool exhausted'),429],[()=>error(401,'invalid_api_key','invalid API key'),401],[()=>error(429,'rate_limit_exceeded','slow down',{'retry-after':'3600'}),429]]) {
    const run=fixture([reply]);
    const result=await run.ask();
    assert.equal(result.status,code);
    assert.equal(run.sent.length,1);
    if (result.headers.has('retry-after')) assert.equal(result.headers.get('retry-after'),'3600');
  }
});

test('client cancellation during Retry-After prevents further sends',async () => {
  const run=fixture([()=>error(429,'rate_limit_exceeded','busy',{'retry-after':'45'})]);
  const controller=new AbortController();
  const request=run.ask(modelBody,{signal:controller.signal});
  while(!run.sent.length) await delay(1);
  controller.abort();
  await assert.rejects(request,{name:'AbortError'});
  assert.equal(run.sent.length,1);
});

const history = [{type:'message',role:'user',content:'hello'}, {type:'reasoning',id:'rs_old',summary:[],encrypted_content:'old-cipher'}, {type:'function_call',call_id:'call_x',name:'lookup',arguments:'{}'}, {type:'function_call_output',call_id:'call_x',output:'result'}];
const historyError = () => error(400,'invalid_request_error','The upstream account bound to this conversation is unavailable. Retry without previous encrypted reasoning items.');
test('account-bound history recovery drops old reasoning but keeps tools and the cache key',async () => {
  const run=fixture([historyError,ok]);
  assert.equal((await run.ask({...modelBody,input:history})).status,200);
  assert.ok(run.sent[0].body.input.some(item=>item.type==='reasoning'));
  assert.deepEqual(run.sent[1].body.input,history.filter(item=>item.type!=='reasoning'));
  assert.equal(run.sent[1].body.prompt_cache_key,'cache-original');
});

test('a server-side reference is never discarded to repair history',async () => {
  const run=fixture([historyError]);
  assert.ok((await run.ask({...modelBody,input:history,previous_response_id:'resp_external'})).status>=400);
  assert.ok(run.sent.every(entry=>entry.body.previous_response_id==='resp_external' && entry.body.input.some(item=>item.type==='reasoning')));
});

test('Codex optional IDs differ from Claude Responses while tool call IDs remain intact',async () => {
  for(const caller of ['codex','claude']) {
    const run=fixture([ok]);
    await run.ask({...modelBody,input:[{type:'message',id:'msg_old',role:'user',content:'hello'}]},{caller});
    assert.equal(run.sent[0].body.input[0].id,caller==='codex'?undefined:'msg_old');
  }
});

test('an interrupted pre-content attempt is hidden; a successful attempt streams to the client',async () => {
  const run=fixture([()=>asEvents(started,{type:'response.reasoning_summary_text.delta',delta:'discarded'},rateEvent),()=>asEvents(started,textEvent,done)]);
  const result=await (await run.ask()).text();
  assert.match(result,/visible/);
  assert.doesNotMatch(result,/discarded|rate_limit_exceeded/);
  assert.equal(run.sent.length,2);
});
for(const [name,event] of [['text',textEvent],['tool',toolEvent]]) test(`${name} delivered before failure is never replayed`,async () => {
  const run=fixture([()=>asEvents(started,event,rateEvent)]);
  const text=await (await run.ask()).text();
  assert.ok(text.includes(event.type));
  assert.equal((await run.ask(modelBody,{round:2})).status,409);
  assert.equal(run.sent.length,1);
});

test('balance is optional and uses the site credential, never the model key',async () => {
  assert.equal(balanceMethod.prompts[1].type,'password');
  assert.deepEqual(await readBalance('https://example.invalid/v1',{type:'api',key:'model'}),{windows:[]});
  let captured;
  const server=http.createServer((req,res)=>{ captured=[req.url,req.headers.authorization,req.headers['new-api-user']];res.end(JSON.stringify({success:true,data:{quota:625000}})); });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const {metadata}=await balanceMethod.authorize({userId:'42',balanceToken:'site-only'});
    assert.equal((await readBalance(`http://127.0.0.1:${server.address().port}/v1`,{key:'model',metadata})).balance,'$1.25');
    assert.deepEqual(captured,['/api/user/self','site-only','42']);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test('unknown SSE output cannot be discarded and replayed',async () => {
  const run=fixture([()=>asEvents(started,{type:'vendor.action',payload:{reserved:true}},rateEvent)]);
  assert.match(await (await run.ask()).text(),/vendor.action/);
  assert.equal(run.sent.length,1);
});

test('explicit incomplete is a terminal outcome, not an empty stream',async () => {
  const run=fixture([()=>asEvents(started,{type:'response.incomplete',response:{status:'incomplete'}})]);
  assert.match(await (await run.ask()).text(),/response.incomplete/);
  assert.equal(run.sent.length,1);
});

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

test('balance sign-in asks for and returns the separate model key',async () => {
  assert.deepEqual(balanceMethod.prompts.map(({key,type})=>[key,type]),[['modelKey','password'],['userId','text'],['balanceToken','password']]);
  const inputs={userId:'42',balanceToken:'site-only'};
  assert.equal((await balanceMethod.authorize(inputs)).type,'failed');
  assert.deepEqual(await balanceMethod.authorize({...inputs,modelKey:'model'}),{type:'success',key:'model',metadata:inputs});
});

test('balance is optional and uses the site credential, never the model key',async () => {
  assert.deepEqual(await readBalance('https://example.invalid/v1',{type:'api',key:'model'}),{balance:'未配置余额查询',windows:[]});
  let captured, quota=625000, usedQuota;
  const server=http.createServer((req,res)=>{ captured=[req.url,req.headers.authorization,req.headers['new-api-user']];res.end(JSON.stringify({success:true,data:{quota,used_quota:usedQuota}})); });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const {metadata}=await balanceMethod.authorize({modelKey:'model',userId:'42',balanceToken:'site-only'});
    assert.equal((await readBalance(`http://127.0.0.1:${server.address().port}/v1`,{key:'model',metadata})).balance,'$1.25');
    assert.deepEqual(captured,['/api/user/self','site-only','42']);
    quota='625000'; usedQuota='250000';
    const withSpend = await readBalance(`http://127.0.0.1:${server.address().port}/v1`,{metadata});
    assert.equal(withSpend.balance,'$1.25');
    assert.deepEqual(withSpend.windows,[{name:'账户累计消耗',display:'$0.50',aside:true}]);
    quota=' '; usedQuota=undefined;
    assert.equal((await readBalance(`http://127.0.0.1:${server.address().port}/v1`,{metadata})).balance,'查询失败');
    quota=0;
    assert.equal((await readBalance(`http://127.0.0.1:${server.address().port}/v1`,{metadata})).balance,'$0.00');
    quota=null;
    assert.equal((await readBalance(`http://127.0.0.1:${server.address().port}/v1`,{metadata})).balance,'查询失败');
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test('balance failures distinguish site authentication, access refusal and an HTML page',async () => {
  let status=401;
  const server=http.createServer((_req,res)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});res.end('<html></html>');});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    for(const [code,expected] of [[401,/401.*系统访问令牌/],[403,/403.*拒绝/],[200,/网页/]]) {
      status=code;
      const result=await readBalance(`http://127.0.0.1:${server.address().port}/v1`,{metadata:{userId:'42',balanceToken:'site-only'}});
      assert.equal(result.balance,'查询失败');
      assert.match(result.error,expected);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test('a shorter per-request retry budget does not wait past a Retry-After',async () => {
  let sends=0;
  const relay=createTransport(async()=>{ sends++; return sends===1 ? error(429,'rate_limit_exceeded','busy',{'retry-after':'2'}) : ok(); });
  const answer=await relay(client(modelBody,[randomUUID(),1]),{caller:'codex',retryRateLimit:true,retryBudgetMs:1000});
  assert.equal(answer.status,429);
  assert.equal(sends,1);
});

test('the retry admission budget does not abort a healthy slow first response',async () => {
  const relay=createTransport(async (_url,{signal})=>{ await delay(1200,undefined,{signal}); return ok(); });
  const result=await relay(client(modelBody,[randomUUID(),1]),{caller:'codex',retryRateLimit:true,retryBudgetMs:1000});
  assert.equal(result.status,200);
});

test('503 and host-delegated 429 do not send again before Retry-After',async () => {
  for(const [status,code,enabled] of [[503,'service_unavailable',true],[429,'rate_limit_exceeded',false]]) {
    const run=fixture([()=>error(status,code,'busy',{'retry-after':'3600','x-request-id':'fixture-wait'}),ok]);
    for (const round of [1,2]) {
      const result=await run.ask(modelBody,{enabled,round});
      assert.equal(result.status,status);
      assert.equal(result.headers.get('retry-after'),'3600');
      assert.equal(result.headers.get('x-request-id'),'fixture-wait');
      assert.equal((await result.json()).error.code,code);
    }
    assert.equal(run.sent.length,1);
  }
});

test('a delegated retry keeps the first service tier even if the host changes it',async () => {
  for(const [first,later] of [['priority',undefined],[undefined,'priority']]) {
    const run=fixture([limit,ok]);
    assert.equal((await run.ask({...modelBody,service_tier:first},{enabled:false})).status,429);
    assert.equal((await run.ask({...modelBody,service_tier:later},{round:2,enabled:false})).status,200);
    assert.deepEqual(run.sent.map(({body})=>body.service_tier),[first,first]);
  }
});

test('HTTP, embedded and streamed Fast refusals do not trigger history recovery or a standard retry',async () => {
  const rejection={code:'unsupported_parameter',param:'service_tier',message:'Unsupported parameter: service_tier'};
  const body={...modelBody,input:history,service_tier:'priority'};
  for(const response of [()=>Response.json({error:rejection},{status:400}),()=>Response.json({error:rejection}),()=>asEvents(started,{type:'response.failed',response:{error:rejection}})]) {
    const run=fixture([response,ok]);
    for(const round of [1,2]) {
      const result=await run.ask(body,{round});
      assert.equal(result.status,400);
      assert.deepEqual((await result.json()).error,rejection);
    }
    assert.equal(run.sent.length,1);
    assert.equal(run.sent[0].body.service_tier,'priority');
  }
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

test('streaming replies preserve upstream diagnostics and remove body encoding headers',async () => {
  const run=fixture([()=>{
    const response=asEvents(started,textEvent,done);
    response.headers.set('x-request-id','fixture-request');
    response.headers.set('x-magpie-sign-in','kept');
    response.headers.set('content-encoding','gzip');
    response.headers.set('content-length','123');
    return response;
  }]);
  const response=await run.ask();
  const text=await response.text();
  assert.match(text,/visible/);
  assert.equal(response.headers.get('x-request-id'),'fixture-request');
  assert.equal(response.headers.get('x-magpie-sign-in'),'kept');
  assert.equal(response.headers.get('content-encoding'),null);
  assert.equal(response.headers.get('content-length'),null);
});

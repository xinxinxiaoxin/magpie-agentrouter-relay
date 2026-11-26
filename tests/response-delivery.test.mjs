import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTransport } from '../lib/transport.mjs';

function events(payloads, headers = {}, status = 200) {
  return new Response(payloads.map(value => `data: ${value === '[DONE]' ? value : JSON.stringify(value)}\n\n`).join(''),
    { status,headers:{...headers,'content-type':'text/event-stream'} });
}

async function deliver(first, path = 'responses') {
  let sends = 0;
  const relay = createTransport(async () => ++sends === 1 ? first : Response.json({recovered:true}),
    {maxAttempts:2,baseDelayMs:1,maxDelayMs:1});
  const input = path === 'responses' ? {input:'hello'} : {messages:[{role:'user',content:'hello'}],max_tokens:32};
  const request = new Request(`https://fixture.invalid/v1/${path}`, {method:'POST',body:JSON.stringify({
    model:'fixture',...input,stream:first.headers.get('content-type')?.startsWith('text/event-stream'),_ag_relay_request:[randomUUID(),1],
  })});
  const response = await relay(request,{caller:path === 'messages' ? 'claude' : 'codex',retryRateLimit:true});
  const text = await response.text();
  return {status:response.status,headers:response.headers,text,sends};
}

const limited = {type:'error',error:{code:'rate_limit_exceeded',message:'Too many requests'}};

test('Responses retries an explicitly empty completed reply, not unknown output or incomplete replies', async () => {
  const empty = {object:'response',status:'completed',output:[]};
  const recovered = await deliver(Response.json(empty));
  assert.equal(recovered.sends,2);
  assert.deepEqual(JSON.parse(recovered.text),{recovered:true});
  for (const body of [
    {...empty,output:[{type:'vendor.result',value:'original'}]},
    {...empty,output:[{type:'function_call',name:'run',call_id:'call_1',arguments:'{}'}]},
    {...empty,output_text:'original'}, {...empty,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}},
    {object:'response',status:'completed'}, {...empty,object:'vendor.result'},
  ]) {
    const result = await deliver(Response.json(body));
    assert.equal(result.sends,1);
    assert.deepEqual(JSON.parse(result.text),body);
  }
});

const chatCases = [
  ['refusal',[{refusal:'Request refused'}]], ['audio',[{audio:{id:'audio_1',data:'sample'}}]],
  ['tool',[{tool_calls:[{id:'call_1',type:'function',function:{name:'run',arguments:'{}'}}]}]],
  ['multiple choices',[{content:''},{content:'Second answer'}]],
];
for (const [name,outputs] of chatCases) test(`Chat ${name} is preserved in JSON and streaming replies`,async () => {
  const choices = outputs.map((output,index) => ({index,message:{role:'assistant',...output},finish_reason:'stop'}));
  const body = {object:'chat.completion',choices};
  const nonstream = await deliver(Response.json(body),'chat/completions');
  assert.equal(nonstream.sends,1);
  assert.deepEqual(JSON.parse(nonstream.text),body);
  const stream = events([{choices:outputs.map((delta,index) => ({index,delta}))},limited]);
  const expected = await stream.clone().text();
  const streamed = await deliver(stream,'chat/completions');
  assert.equal(streamed.sends,1);
  assert.equal(streamed.text,expected);
});

test('Chat distinguishes a terminal content filter from an empty stop',async () => {
  for (const [finishReason,sends] of [['content_filter',1],['stop',2]]) {
    const choices = [{index:0,delta:{role:'assistant',content:null},finish_reason:finishReason}];
    const response = await deliver(events([{choices},'[DONE]']),'chat/completions');
    assert.equal(response.sends,sends);
    if (sends === 1) assert.match(response.text,/content_filter/);
  }
});

for (const event of [
  {type:'response.refusal.done',refusal:'Request refused'},
  {type:'response.function_call_arguments.done',item_id:'fc_1',arguments:'{}'},
  {type:'response.output_item.done',item:{type:'function_call',name:'run',call_id:'call_1',arguments:'{}'}},
  {type:'response.output_item.done',item:{type:'message',content:[{type:'output_text',text:'Original answer'}]}},
  {type:'response.content_part.done',part:{type:'vendor.attachment',value:'original'}},
]) test(`Responses ${event.type}${event.item ? ` (${event.item.type})` : ''} is delivered before a later error`,async () => {
  const reply = events([event,limited]);
  const expected = await reply.clone().text();
  const result = await deliver(reply);
  assert.equal(result.sends,1);
  assert.equal(result.text,expected);
});

test('Messages preserves unfamiliar blocks, redacted thinking and explicit refusal',async () => {
  const block = {type:'vendor.result',data:'original'};
  const stream = events([{type:'content_block_start',index:0,content_block:block},limited]);
  const expected = await stream.clone().text();
  const streamed = await deliver(stream,'messages');
  assert.equal(streamed.sends,1);
  assert.equal(streamed.text,expected);
  for (const body of [{content:[block]}, {content:[{type:'redacted_thinking',data:'original'}]}, {content:[],stop_reason:'refusal'}]) {
    const result = await deliver(Response.json({type:'message',...body}),'messages');
    assert.equal(result.sends,1);
    assert.deepEqual(JSON.parse(result.text),{type:'message',...body});
  }
});

const failures = [
  [{code:'invalid_api_key',type:'authentication_error',message:'Invalid API key'},401],
  [{code:'model_not_found',type:'invalid_request_error',param:'model',message:'No access to model'},404],
  [{code:'insufficient_quota',type:'insufficient_quota',message:'Quota exhausted'},402],
];
for (const [error,status] of failures) test(`embedded ${error.code} preserves its cause, status and headers`,async () => {
  for (const signIn of [undefined,'kept',...(status === 401 ? ['expired'] : [])]) {
    const headers = {'x-request-id':'fixture-request',...(signIn && {'x-magpie-sign-in':signIn})};
    for (const reply of [Response.json({error},{headers}), events([{type:'response.failed',response:{error}}],headers)]) {
      const result = await deliver(reply);
      assert.equal(result.sends,1);
      assert.equal(result.status,status);
      assert.equal(result.headers.get('x-request-id'),'fixture-request');
      assert.equal(result.headers.get('x-magpie-sign-in'),signIn ?? null);
      assert.match(result.headers.get('content-type'),/application\/json/);
      assert.deepEqual(JSON.parse(result.text),{error});
    }
  }
});

test('a real 401 marks a bad key but not a model-only rejection',async () => {
  for (const [error,status] of [[failures[0][0],401],[failures[1][0],404],
    [{code:'model_not_found',message:'Model unavailable because the API key is invalid'},401],
    [{code:'model_not_found',message:'Model not available. Please supply a valid token.'},401]]) {
    const result = await deliver(Response.json({error},{status:401,headers:{'x-request-id':'fixture-401'}}));
    assert.equal(result.sends,1);
    assert.equal(result.status,status);
    assert.equal(result.headers.get('x-request-id'),'fixture-401');
    assert.deepEqual(JSON.parse(result.text),{error});
  }
});

test('successful responses keep their upstream status and no-body replies stay empty',async () => {
  const queued = {object:'response',status:'queued',output:[]};
  const accepted = await deliver(Response.json(queued,{status:202}));
  assert.equal(accepted.status,202);
  assert.deepEqual(JSON.parse(accepted.text),queued);
  const stream = events([{type:'response.output_text.delta',delta:'original'},{type:'response.completed'}],{'x-request-id':'stream'},202);
  const expected = await stream.clone().text();
  const streamed = await deliver(stream);
  assert.equal(streamed.status,202);
  assert.equal(streamed.headers.get('x-request-id'),'stream');
  assert.equal(streamed.text,expected);
  for (const status of [204,205]) {
    const empty = await deliver(new Response(null,{status,headers:{'content-type':'text/event-stream','x-request-id':'empty'}}));
    assert.equal(empty.status,status);
    assert.equal(empty.sends,1);
    assert.equal(empty.headers.get('x-request-id'),'empty');
    assert.equal(empty.text,'');
  }
});

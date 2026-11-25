import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createTransport } from '../lib/transport.mjs';

const core=await realpath(process.argv[2]);
assert.equal(createHash('sha256').update(await readFile(core)).digest('hex'),'5772ebcd4ec3357dd9e8dc38bdbf6a902c305e2ffeb64f4d24611ac9ece2ba43');
const parent=fileURLToPath(new URL('../.sandbox',import.meta.url));
await mkdir(parent,{recursive:true});
const tmp=await mkdtemp(path.join(parent,'parity-'));
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
let sendReply, calls=[];
const upstream=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req) chunks.push(chunk);
  calls.push(JSON.parse(Buffer.concat(chunks)));
  const [status,body]=sendReply(calls.length);
  res.writeHead(status,{'content-type':typeof body==='string'?'text/event-stream':'application/json'});
  res.end(typeof body==='string'?body:JSON.stringify(body));
});
const base=await listen(upstream);
const reservation=http.createServer();
const local=await listen(reservation);
await close(reservation);
const gateway=spawn(process.execPath,[core],{cwd:tmp,windowsHide:true,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot,PROXY_HOST:'127.0.0.1',PROXY_PORT:new URL(local).port,PROXY_UPSTREAM:base,PROXY_VERBOSE:'0',PROXY_DIAGNOSTICS_FILE:path.join(tmp,'synthetic.jsonl'),PROXY_POLICY_JSON:JSON.stringify({schemaVersion:1,profiles:{codex:{maxAttempts:4,baseDelayMs:1,maxDelayMs:1},general:{maxAttempts:4,baseDelayMs:1,maxDelayMs:1}}})}});
const stopped=once(gateway,'close');
try {
  let ready=false;
  for(let attempt=0;attempt<100&&!ready;attempt++){
    try{ready=(await (await fetch(`${local}/_relay/status`,{signal:AbortSignal.timeout(500)})).json()).pid===gateway.pid;}catch{}
    if(!ready) await delay(50);
  }
  assert.ok(ready,'isolated baseline failed to start');
  const good=[200,{output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'fixture'}]}]}];
  const rate={error:{code:'rate_limit_exceeded',message:'Too many requests'}};
  const body={model:'fixture',prompt_cache_key:'fixed',input:[{type:'message',id:'msg_x',role:'user',content:'continue'},{type:'reasoning',id:'rs_old',summary:[],encrypted_content:'fixture'}]};
  const event=object=>`data: ${JSON.stringify(object)}\n\n`;
  const created=event({type:'response.created',response:{id:'resp_temp'}});
  const tool=event({type:'response.output_item.added',item:{type:'function_call',name:'lookup',call_id:'call_x'}});
  const completed=event({type:'response.completed',response:{status:'completed'}});
  const cases=[
    ['first send',()=>good],['HTTP rate',count=>count===1?[429,rate]:good],['JSON rate',count=>count===1?[200,rate]:good],
    ['permanent',()=>[401,{error:{code:'invalid_api_key',message:'invalid API key'}}]],
    ['history repair',count=>count===1?[400,{error:{message:'upstream account bound to this conversation is unavailable; retry without previous encrypted reasoning items'}}]:good],
    ['prelude retry',count=>[200,count===1?created+event({type:'error',...rate}):created+completed]],
    ['committed tool',()=>[200,created+tool+event({type:'error',...rate})]],
  ];
  for(const [name,reply] of cases){
    const histories=[];
    for(const implementation of ['baseline','plugin']){
      calls=[];sendReply=reply;
      const session=randomUUID();
      const request=new Request(`${implementation==='plugin'?base:local}/v1/responses`,{method:'POST',headers:{'content-type':'application/json','x-relay-client':'codex','x-relay-session-id':session},signal:AbortSignal.timeout(15000),body:JSON.stringify(implementation==='plugin'?{...body,_ag_relay_request:[session,1]}:body)});
      const result=implementation==='plugin'?await createTransport(fetch,{maxAttempts:4,baseDelayMs:1,maxDelayMs:1})(request,{caller:'codex',retryRateLimit:true}):await fetch(request);
      histories.push({status:result.status,text:await result.text(),calls});
    }
    assert.deepEqual(histories[1],histories[0],name);
    console.log(`PASS: ${name} (${histories[0].calls.length} sends, same payloads and reply)`);
  }
}finally{
  gateway.kill();await stopped;await close(upstream);
  assert.equal(path.dirname(await realpath(tmp)),await realpath(parent));
  await rm(tmp,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../provider.mjs';
import { createProvider } from '../lib/provider.mjs';

test('Fast preserves model aliases, capabilities and reasoning variants and is only offered on Chat and Responses',async () => {
  const {provider}=await plugin();
  const model={id:'local-alias',name:'Local alias',api:{id:'vendor-id',npm:'@ai-sdk/openai'},limit:{context:65536},capabilities:{reasoning:false},variants:{low:{}}};
  const anthropic={...model,api:{npm:'@ai-sdk/anthropic'}};
  const google={...model,api:{npm:'@ai-sdk/google'}};
  const chat={...model,api:{npm:'@ai-sdk/openai-compatible'}};
  const listed=await provider.models({models:{'local-alias':model,anthropic,google,chat}});
  assert.deepEqual(listed,{'local-alias':{...model,serviceTiers:['priority']},anthropic,google,chat:{...chat,serviceTiers:['priority']}});
  assert.equal(model.serviceTiers,undefined);
});

test('unknown destinations and missing keys never reach the transport', async () => {
  const { auth } = await plugin();
  const transport = await auth.loader(async () => ({ type: 'api', key: '' }));
  assert.equal((await transport.fetch('https://example.invalid/v1/models')).status, 400);
  assert.equal((await transport.fetch('https://agentrouter.org/v1/models')).status, 401);
});

test('host identity and the current switch are request-local, not forwarded as headers', async () => {
  let enabled = true;
  const captures = [];
  const { auth } = await createProvider('https://example.invalid/v1', (req, options) => {
    captures.push(options);
    assert.equal(req.headers.get('x-magpie-caller-agent'), null);
    assert.equal(req.headers.get('authorization'), 'Bearer fixture');
    return new Response('ok');
  })({ magpie: { option: () => enabled } });
  const transport = await auth.loader(async () => ({ type: 'api', key: 'fixture' }));
  for (const [caller, ua] of [['codex', 'local'], ['claude', 'local'], ['codex', 'claude'], ['', 'local']]) {
    await transport.fetch('https://example.invalid/v1/responses', { headers: { 'x-magpie-caller-agent': caller, 'user-agent': ua } });
    enabled = false;
  }
  assert.deepEqual(captures, ['codex','claude','general','general'].map((caller,index) => ({ caller, retryRateLimit: !index, retryBudgetMs:300000 })));
});

test('every UA is forwarded as received, including unknown and absent values',async () => {
  const received=[];
  const {auth}=await createProvider('https://example.invalid/v1',request=>{received.push(request.headers.get('user-agent'));return new Response('ok');})();
  const transport=await auth.loader(async()=>({type:'api',key:'fixture'}));
  for(const [agent,ua] of [['codex','codex_cli_rs/0.167.0 extra'],['claude','claude-cli/2.1.0 (external, cli)'],['claude',null],['codex','other/1'],['codex','magpie/0.1.4777']]) {
    const response=await transport.fetch('https://example.invalid/v1/responses',{method:'POST',headers:{'x-magpie-caller-agent':agent,...(ua===null?{}:{'user-agent':ua})},body:'{}'});
    assert.equal(response.status,200);
  }
  assert.deepEqual(received,['codex_cli_rs/0.167.0 extra','claude-cli/2.1.0 (external, cli)',null,'other/1','magpie/0.1.4777']);
});

test('retry budget option is validated and passed in milliseconds',async () => {
  const budgets=[];
  for(const seconds of [60,0,301,'60']) {
    const {auth}=await createProvider('https://example.invalid/v1',(_request,ctx)=>{budgets.push(ctx.retryBudgetMs);return new Response('ok');})({}, {retryBudgetSeconds:seconds});
    const transport=await auth.loader(async()=>({type:'api',key:'fixture'}));
    const result=await transport.fetch('https://example.invalid/v1/responses',{method:'POST',headers:{'x-magpie-caller-agent':'codex','user-agent':'codex_cli_rs/1.0'},body:'{}'});
    assert.equal(result.status,seconds===60?200:400);
  }
  assert.deepEqual(budgets,[60000]);
});

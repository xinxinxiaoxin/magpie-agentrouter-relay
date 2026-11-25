import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../provider.mjs';
import { createProvider } from '../lib/provider.mjs';

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
  assert.deepEqual(captures, ['codex','claude','general','general'].map((caller,index) => ({ caller, retryRateLimit: !index })));
});

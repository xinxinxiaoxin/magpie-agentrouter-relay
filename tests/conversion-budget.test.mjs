import assert from 'node:assert/strict';
import test from 'node:test';
import { defaults } from '../lib/settings.mjs';
import { onAccount, onProvider } from '../relay.middleware.mjs';

const account = { provider: 'agentrouter-relay', kind: 'plugin', ref: 'fixture-account' };
const turn = (protocol, options = {}) => ({ protocol, options, state: {} });

for (const protocol of ['responses','anthropic', 'chat', 'gemini']) {
  test(`${protocol}: host attempts share one cap across models and accounts in a request`, () => {
    const context = turn(protocol);
    for (let attempt = 1; attempt <= defaults.maxAttempts; attempt++) {
      assert.equal(onAccount({ ...account, model: `model-${attempt % 2}`, ref: `account-${attempt % 2}` }, context), undefined);
    }
    assert.deepEqual(onAccount(account, context), { skip: true });
    assert.equal(onAccount(account, turn(protocol)), undefined);
  });
}

test('converted attempts use one deadline from the first admission', context => {
  let now = 10000;
  context.mock.method(Date, 'now', () => now);
  const short = turn('anthropic', { retryBudgetSeconds: 32 });
  const standard = turn('chat');
  assert.equal(onAccount(account, short), undefined);
  assert.equal(onAccount(account, standard), undefined);
  now += 2000;
  assert.equal(onAccount(account, short), undefined);
  now++;
  assert.deepEqual(onAccount(account, short), { skip: true });
  now = 10000 + defaults.totalBudgetMs - defaults.minRetryWindowMs;
  assert.equal(onAccount(account, standard), undefined);
  now++;
  assert.deepEqual(onAccount(account, standard), { skip: true });
});

test('the provider gets the first attempt to report an invalid configured budget', () => {
  assert.equal(onAccount(account, turn('anthropic', { retryBudgetSeconds: 0 })), undefined);
});

test('other providers and account kinds are unrestricted; direct Responses keep their marker', () => {
  const context = turn('anthropic');
  assert.equal(onAccount({ ...account, provider: 'other-provider' }, context), undefined);
  assert.equal(onAccount({ ...account, kind: 'claude' }, context), undefined);
  assert.deepEqual(context.state, {});

  const direct = { ...turn('responses'), provider: { id: account.provider } };
  assert.equal(onAccount(account, direct), undefined);
  const body = { model: 'fixture', metadata: { user_id: 'original' } };
  const first = onProvider(body, direct), next = onProvider(body, direct);
  assert.deepEqual(next._ag_relay_request, [first._ag_relay_request[0], 2]);
  assert.deepEqual(first.metadata, body.metadata);
  assert.deepEqual(body, { model: 'fixture', metadata: { user_id: 'original' } });
});

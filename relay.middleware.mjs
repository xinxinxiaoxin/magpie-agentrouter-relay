import { defaults } from './lib/settings.mjs';

export function onAccount(account, ctx) {
  if (account.provider !== 'agentrouter-relay' || account.kind !== 'plugin') return;
  const now = Date.now();
  const budget = ctx.state.accountBudget;
  if (!budget) {
    const seconds = ctx.options.retryBudgetSeconds ?? defaults.totalBudgetMs / 1000;
    ctx.state.accountBudget = { attempts: 1, deadline: now + seconds * 1000 };
    return;
  }
  if (budget.attempts >= defaults.maxAttempts || budget.deadline - now < defaults.minRetryWindowMs) return { skip: true };
  budget.attempts++;
}

export function onProvider(body, ctx) {
  if (ctx.provider?.id !== 'agentrouter-relay' || !body || typeof body !== 'object') return;
  if (!ctx.state.relayId) {
    ctx.state.relayId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    ctx.state.relayTry = 0;
  }
  return { ...body, _ag_relay_request: [ctx.state.relayId, ++ctx.state.relayTry] };
}

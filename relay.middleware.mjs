export function onProvider(body, ctx) {
  if (ctx.provider?.id !== 'agentrouter-relay' || !body || typeof body !== 'object') return;
  if (!ctx.state.relayId) {
    ctx.state.relayId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    ctx.state.relayTry = 0;
  }
  return { ...body, _ag_relay_request: [ctx.state.relayId, ++ctx.state.relayTry] };
}

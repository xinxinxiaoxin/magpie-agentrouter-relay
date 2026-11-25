import { createTransport } from './transport.mjs';
import { balanceMethod, readBalance } from './balance.mjs';

export const providerId = 'agentrouter-relay';
export const retryOption = 'retry-rate-limit';

function failure(status, message) {
  return Response.json({ error: { message } }, { status });
}

function getCaller(headers) {
  const agent = headers.get('x-magpie-caller-agent');
  const userAgent = headers.get('user-agent')?.toLowerCase() ?? '';
  if (agent === 'codex' && !/claude|zcode/.test(userAgent)) return agent;
  if (agent === 'claude' && !/codex|zcode/.test(userAgent)) return agent;
  return 'general';
}

export function createProvider(base, send = createTransport()) {
  const operations = new Set(['responses', 'responses/compact', 'responses/input_tokens', 'messages', 'messages/count_tokens', 'chat/completions', 'models'].map(operation => `${base}/${operation}`));
  return async function agentRouter(input = {}) {
    return {
      config: async config => {
        config.provider ??= {};
        config.provider[providerId] = { name: 'AgentRouter · AG Relay', api: base, npm: '@ai-sdk/openai', models: {}, ...config.provider[providerId] };
      },
      auth: {
        provider: providerId,
        methods: [{ type: 'api', label: 'AgentRouter API Key' }, balanceMethod],
        usage: async (getAuth, _provider, options) => readBalance(base,await getAuth(),options?.signal),
        options: [{ key: retryOption, label: '临时限流由插件重试', description: '仅控制普通临时限流，不改变其他恢复规则。', default: true }],
        async loader(getAuth) {
          return { baseURL: base, async fetch(source, init) {
            const request = new Request(source, init);
            const target = new URL(request.url);
            if (!operations.has(target.origin + target.pathname) || target.username || target.password) return failure(400, 'Unexpected AgentRouter endpoint');
            const auth = await getAuth();
            if (auth?.type !== 'api' || !auth.key?.trim()) return failure(401, 'AgentRouter API Key required');
            request.signal.throwIfAborted();
            const caller = getCaller(request.headers);
            const headers = new Headers(request.headers);
            const session = headers.get('x-magpie-session');
            for (const name of [...headers.keys()]) if (name.startsWith('x-magpie-') || ['x-relay-client','cookie','proxy-authorization','x-api-key','host','content-length'].includes(name)) headers.delete(name);
            headers.set('authorization', `Bearer ${auth.key}`);
            headers.delete('api-key');
            headers.delete('x-relay-session-id');
            if (session && request.method === 'POST') headers.set('x-relay-session-id',session);
            const retryRateLimit = input.magpie?.option?.(providerId, retryOption) ?? true;
            return send(new Request(request, { headers, redirect: 'error' }), { caller, retryRateLimit });
          } };
        },
      },
      provider: { id: providerId, async models(provider, { auth, signal } = {}) {
        if (auth?.type !== 'api' || !auth.key?.trim()) return provider.models;
        const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${auth.key}` }, redirect: 'error', signal });
        if (!response.ok) throw new Error(`AgentRouter models: HTTP ${response.status}`);
        const { data } = await response.json();
        if (!Array.isArray(data)) throw new Error('AgentRouter models: invalid response');
        return Object.fromEntries(data.filter(model => typeof model?.id === 'string' && model.id.trim()).map(({ id, supported_endpoint_types: endpoints }) => {
          const formats = Array.isArray(endpoints) ? endpoints : [];
          const packages = [...new Set(formats.map(format => ({ anthropic:'@ai-sdk/anthropic', 'openai-response':'@ai-sdk/openai', openai:'@ai-sdk/openai-compatible' })[format]).filter(value => typeof value === 'string'))];
          const [npm = '@ai-sdk/openai', ...also] = packages;
          return [id, { id, name:id, also, api:{ id, url:base, npm } }];
        }));
      } },
    };
  };
}

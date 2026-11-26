import { createTransport } from './transport.mjs';
import { balanceMethod, readBalance } from './balance.mjs';
import { configureUA } from './setup-ua.mjs';

export const providerId = 'agentrouter-relay';
export const retryOption = 'retry-rate-limit';

function failure(status, message) {
  return Response.json({ error: { message } }, { status });
}

function getCaller(headers) {
  const agent = headers.get('x-magpie-caller-agent');
  const userAgent = headers.get('user-agent')?.toLowerCase() ?? '';
  if (agent === 'codex' && !/claude|zcode/.test(userAgent)) return agent;
  if ((agent === 'claude' || agent === 'claude-desktop') && !/codex|zcode/.test(userAgent)) return 'claude';
  return 'general';
}

export function createProvider(base, send = createTransport()) {
  const operations = new Set(['responses', 'responses/compact', 'responses/input_tokens', 'messages', 'messages/count_tokens', 'chat/completions', 'models'].map(operation => `${base}/${operation}`));
  return async function agentRouter(input = {}, options = {}) {
    if (input.magpie && input.directory) {
      await configureUA(input.directory).catch(()=>console.warn('AG Relay：未能保存 UA 透传设置，继续使用宿主提供的请求头。'));
    }
    return {
      config: async config => {
        config.provider ??= {};
        const existing = config.provider[providerId];
        const models = { ...existing?.models };
        for (const id of ['gpt-6.1-sol','gpt-6-astra','gpt-5.6-sol']) models[id] = { reasoning:true, ...models[id] };
        config.provider[providerId] = { name: 'AgentRouter · AG Relay', api: base, npm: '@ai-sdk/openai', ...existing, models };
      },
      auth: {
        provider: providerId,
        methods: [{ type: 'api', label: 'AgentRouter API Key' }, balanceMethod],
        usage: async (getAuth, _provider, options) => ({ ...await readBalance(base,await getAuth(),options?.signal), signIn:'kept' }),
        options: [
          { key: retryOption, label: '临时限流由插件重试', description: '仅控制普通临时限流，不改变其他恢复规则。', default: true },
          { key: 'forward-client-ua', label: '透传客户端 UA', description: '把客户端的 User-Agent 原样发给 AgentRouter。关闭后使用发送请求的运行时默认值。', default: true },
        ],
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
            if (input.magpie?.option?.(providerId,'forward-client-ua') === false) headers.delete('user-agent');
            const session = headers.get('x-magpie-session');
            for (const name of [...headers.keys()]) if (name.startsWith('x-magpie-') || ['x-relay-client','cookie','proxy-authorization','x-api-key','host','content-length'].includes(name)) headers.delete(name);
            headers.set('authorization', `Bearer ${auth.key}`);
            headers.delete('api-key');
            headers.delete('x-relay-session-id');
            if (session && request.method === 'POST') headers.set('x-relay-session-id',session);
            const retryRateLimit = input.magpie?.option?.(providerId, retryOption) ?? true;
            const seconds = options.retryBudgetSeconds ?? 300;
            if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) return failure(400,'retryBudgetSeconds 必须是 1 至 300 的整数秒。');
            return send(new Request(request, { headers, redirect: 'error' }), { caller, retryRateLimit, retryBudgetMs:seconds*1000 });
          } };
        },
      },
    };
  };
}

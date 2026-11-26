export const balanceMethod = {
  type:'api', label:'API Key + 可选账户余额',
  prompts:[
    {type:'password',key:'modelKey',message:'AgentRouter 模型 API Key（用于聊天）'},
    {type:'text',key:'userId',message:'余额查询：AgentRouter 用户 ID'},
    {type:'password',key:'balanceToken',message:'余额查询：AgentRouter 系统访问令牌（不是模型 Key）'},
  ],
  async authorize(inputs) {
    const modelKey = String(inputs?.modelKey ?? '').trim();
    if (!modelKey || /[\r\n]/.test(modelKey)) return {type:'failed',error:'请输入用于聊天的模型 API Key。'};
    const userId = String(inputs?.userId ?? '').trim();
    const balanceToken = String(inputs?.balanceToken ?? '').trim();
    if (!/^\d+$/.test(userId) || !balanceToken || /[\r\n]/.test(balanceToken)) return {type:'failed',error:'需要数字用户 ID 和余额查询令牌。仅聊天请选择第一项。'};
    return {type:'success', key:modelKey, metadata:{userId,balanceToken}};
  },
};

function quotaDollars(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return undefined;
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${(amount/500000).toFixed(2)}` : undefined;
}

export async function readBalance(base, auth, signal) {
  const {userId,balanceToken} = auth?.metadata ?? {};
  if (!/^\d+$/.test(userId ?? '') || !balanceToken) return {balance:'未配置余额查询',windows:[]};
  const timeout = AbortSignal.timeout(10000);
  try {
    const response = await fetch(new URL('/api/user/self',base),{ headers:{ authorization:balanceToken, 'New-Api-User':String(userId) }, redirect:'error',signal:signal ? AbortSignal.any([signal,timeout]) : timeout });
    if (response.status === 401) return {balance:'查询失败',error:'余额接口 HTTP 401：请核对用户 ID 和系统访问令牌，无需更换聊天用的模型 Key。',windows:[]};
    if (response.status === 403) return {balance:'查询失败',error:'余额接口 HTTP 403：站点拒绝查询账户余额。',windows:[]};
    if (!response.ok) return {balance:'查询失败',error:`余额接口 HTTP ${response.status}`,windows:[]};
    if (/^text\/html\b/i.test(response.headers.get('content-type') ?? '')) return {balance:'查询失败',error:'余额接口返回了网页，没有返回账户额度。',windows:[]};
    const payload = await response.json();
    const balance = quotaDollars(payload.data?.quota);
    if (payload.success === false || balance === undefined) return {balance:'查询失败',error:'余额接口未返回有效额度',windows:[]};
    const spent = quotaDollars(payload.data?.used_quota);
    return {balance,windows:spent === undefined ? [] : [{name:'账户累计消耗',display:spent,aside:true}]};
  } catch {
    signal?.throwIfAborted();
    return {balance:'查询失败',error:'余额接口超时、不可用或返回格式错误',windows:[]};
  }
}

export const balanceMethod = {
  type:'api', label:'API Key + 可选账户余额',
  prompts:[
    {type:'text',key:'userId',message:'余额查询：AgentRouter 用户 ID'},
    {type:'password',key:'balanceToken',message:'余额查询：AgentRouter 系统访问令牌（不是模型 Key）'},
  ],
  async authorize(inputs) {
    const userId = String(inputs?.userId ?? '').trim();
    const balanceToken = String(inputs?.balanceToken ?? '').trim();
    if (!/^\d+$/.test(userId) || !balanceToken || /[\r\n]/.test(balanceToken)) return {type:'failed',error:'需要数字用户 ID 和余额查询令牌。仅聊天请选择第一项。'};
    return {type:'success', metadata:{userId,balanceToken}};
  },
};

export async function readBalance(base, auth, signal) {
  const {userId,balanceToken} = auth?.metadata ?? {};
  if (!/^\d+$/.test(userId ?? '') || !balanceToken) return {windows:[]};
  const timeout = AbortSignal.timeout(10000);
  const response = await fetch(new URL('/api/user/self',base),{ headers:{ authorization:balanceToken, 'New-Api-User':String(userId) }, redirect:'error',signal:signal ? AbortSignal.any([signal,timeout]) : timeout });
  if (!response.ok) throw new Error(`AgentRouter 余额查询：HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.success === false || typeof payload.data?.quota !== 'number' || !Number.isFinite(payload.data.quota)) throw new Error('AgentRouter 余额字段不可用');
  return {balance:`$${(payload.data.quota/500000).toFixed(2)}`,windows:[]};
}

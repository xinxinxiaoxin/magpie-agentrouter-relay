import { createHash } from 'node:crypto';
import { defaults as cfg, profileFor } from './settings.mjs';

const log = () => {};
const observeRequest = () => {};

function progressKind(obj) {
  const type = String(obj.type || '');
  const block = obj.content_block || obj.delta;
  if (obj.item?.type === 'reasoning' || type.includes('reasoning') ||
      block?.type === 'thinking_delta' || block?.type === 'thinking') return 'reasoning';
  if (obj.item?.type === 'function_call' || type.includes('function_call') ||
      block?.type === 'input_json_delta' || block?.type === 'tool_use') return 'tool';
  for (const choice of Array.isArray(obj.choices) ? obj.choices : []) {
    const delta = choice?.delta;
    if (nonEmptyStr(delta?.reasoning_content) || nonEmptyStr(delta?.reasoning)) return 'reasoning';
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length) return 'tool';
  }
  return 'text';
}

// Classification sees the cause, not opaque identifiers or diagnostic URLs. Keep
// item prefixes and parameter paths so precise history/status errors stay recognizable.
function errorCauseText(message) {
  return String(message || '')
    .replace(/\[\s*(?:request|trace|response|item)[_ -]?id\s*[:=][^\]\r\n]*\]|\(\s*(?:request|trace|response|item)[_ -]?id\s*[:=][^)\r\n]*\)/gi, ' ')
    .replace(/\bhttps?:\/\/[^\s<>"'\])]+/gi, ' ')
    .replace(/\b(?:request|trace|response|item)[_ -]?id\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s)\],;]+)/gi, ' ')
    .replace(/\b(rs|ws|msg|resp|fc|call)_[a-z0-9_.:-]+/gi, '$1_opaque');
}

// 明确的暂时性错误码 → 值得重试
// 注意：不含 insufficient_quota —— 配额耗尽属于确定性错误，重试无意义。
const RETRYABLE_CODES = new Set([
  'rate_limit_exceeded', 'too_many_requests', 'server_error',
  'internal_server_error', 'overloaded', 'overloaded_error', 'service_unavailable',
  'temporarily_unavailable', 'timeout', 'upstream_error', 'capacity',
  ...cfg.extraRetryCodes,
]);

// 没有 code 时按文案兜底判断是否暂时性
// 注意 "no deployment / deployment to match"：模型名本身是有效的（在服务商 /v1/models
// 里能查到），报这个错说明上游部分通道缺少该部署，属于偶发路由问题 —— 重试有机会命中好通道。
const RETRYABLE_TEXT =
  /\b(?:rate[ _-]?limit(?:ed| exceeded)?|too many requests|overload(?:ed)?|temporar(?:y|ily)|try again|timeout|timed out|unavailable|capacity|internal (?:server )?error|bad gateway|gateway (?:error|timeout)|no deployment|deployment to match)\b|\b(?:HTTP(?: status(?: code)?)?|status(?: code)?|error(?: code)?)\s*[:=]?\s*(?:502|503|504)\b/i;

// Exact provider codes are evidence; code substrings and opaque identifiers are not.
const PERMANENT_CODES = new Set([
  'invalid_api_key', 'incorrect_api_key', 'unauthorized', 'authentication_error',
  'permission_denied', 'insufficient_permissions', 'account_disabled', 'account_deactivated',
  'context_length_exceeded', 'model_not_found', 'invalid_model', 'unsupported_model',
  'content_blocked', 'content-blocked', 'content_filter', 'content_filter_error',
  'content-filter', 'contentfilter', 'flagged', 'moderation',
  'sensitive_words', 'request_too_large',
]);
const QUOTA_CODES = new Set(['insufficient_quota', 'quota_exceeded', 'quota_exhausted', 'insufficient_balance', 'payment_required']);
const PERMANENT_TEXT =
  /\b(?:invalid api key|incorrect api key|invalid_api_key|unauthorized|authentication failed|authentication_error|insufficient permissions|permission denied|account (?:is )?(?:deactivated|disabled|suspended))\b/i;

function isPermanentError(info) {
  return !!info && (PERMANENT_CODES.has(String(info.code || info.type || '').toLowerCase())
    || PERMANENT_TEXT.test(errorCauseText(info.message)));
}

// 「找不到部署 / 无可用渠道」仍可能通过重试命中可用通道。
// 使用通道重试间隔，并补足最低尝试机会；不降低用户配置的常规次数。
const DEPLOYMENT_TEXT = /\b(?:no deployment|deployment to match)\b|无可用渠道|无可用模型|无可用线路|模型不存在/i;
function isDeploymentError(info) {
  return !!info && DEPLOYMENT_TEXT.test(errorCauseText(info.message));
}

/**
 * Responses 的推理项可能绑定上游资源；协议由客户端/网关配置决定，
 * 不能根据 ZCode / Claude / Codex 的名称推断协议。
 * 删除不可用 reasoning 会损失推理连续性，并非无损修复。
 */
const REASONING_ITEM_TEXT =
  /\bencrypted content (?:for item ['"]?rs_[^'"\s]+['"]? )?could not be (?:verified|decrypted|parsed)\b|\bencrypted content (?:could not|failed)\b|\bitems are not persisted when .?store.? is set to false\b|\bitem with id ['"]rs_[^'"\r\n]+['"] not found\b/i;

function isReasoningItemError(text) {
  return REASONING_ITEM_TEXT.test(String(text || ''));
}

// The upstream explicitly asks for a conversation without prior encrypted reasoning.
// Both phrases are required: "unavailable" alone is also used by ordinary 503s.
const ACCOUNT_REASONING_BOUND_TEXT = /\bupstream account bound to this conversation\b/i;
const WITHOUT_ENCRYPTED_REASONING_TEXT = /\bwithout previous encrypted reasoning items\b/i;

// Only admitted by the strict Codex branch; other clients keep their existing policy.
const MISSING_SEARCH_REASONING_TEXT =
  /\bitem ['"]ws_[^'"\r\n]+['"] of type ['"]web_search_call['"] was provided without its required ['"]reasoning['"] item:\s*['"]rs_[^'"\r\n]+['"]/i;

// 上游会在消息末尾附加 "[trace_id=...]"，所以必须用子串/正则匹配，
// 不能用全等比较 —— 否则永远匹配不上，修复逻辑形同虚设。
const AZURE_RESOURCE_TEXT =
  /\bthe requested item was created under a different (?:azure|\*\*\*) openai resource\b/i;
function isAzureResourceError(message) {
  return AZURE_RESOURCE_TEXT.test(String(message || ''));
}

/** Allowlisted shape only: never copy arbitrary type/role/store values from input. */
function summarizeResponsesBody(bodyBuf) {
  try {
    const obj = JSON.parse(bodyBuf.toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { inputType: 'non_object' };
    const types = {};
    const allowed = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'item_reference']);
    let withId = 0;
    if (Array.isArray(obj.input)) {
      for (const it of obj.input) {
        const object = it && typeof it === 'object' && !Array.isArray(it);
        const t = !object ? 'non_object' : allowed.has(it.type) ? it.type
          : it.type === undefined && typeof it.role === 'string' ? 'message_no_type' : 'other';
        types[t] = (types[t] || 0) + 1;
        if (object && Object.hasOwn(it, 'id')) withId++;
      }
    }
    return {
      inputType: Array.isArray(obj.input) ? 'array' : typeof obj.input === 'string' ? 'string' : 'other',
      inputLength: Array.isArray(obj.input) ? obj.input.length : null,
      itemsWithId: withId,
      types,
      previousResponseId: obj.previous_response_id != null,
      conversation: obj.conversation != null,
    };
  } catch { return { inputType: 'invalid_json' }; }
}

/**
 * Conservative stateless replay. Only inline message/function/custom-tool items have optional
 * item ids removed; never recurse into content, arguments, output, or call_id.
 * Confirmed Codex history errors may opt into stateless web-search replay: remove
 * reasoning and search handles together, preserving the inline search payload.
 * Dropping reasoning is lossy; handle-only recovery retains its payloads.
 * Neither fallback is portable Responses validation.
 * Server-side history cannot be reconstructed or proven complete by this proxy.
 *
 * Callers select a repair purpose and the already-established Codex history eligibility.
 * Field removal and completeness requirements belong to that purpose, not its callers.
 *
 * Ordinary optional-id/type removals preserve inline content. The Codex fallback
 * additionally sacrifices old reasoning continuity and resource-bound search linkage.
 */
function repairResponsesItems(bodyBuf, purpose, codexHistory = false) {
  let options;
  switch (purpose) {
    case 'preflight':
      options = { stripItemIds: true, dropReasoning: true, allowUnchanged: true, requireCompleteTools: true };
      break;
    case 'session_compat':
      options = { stripItemIds: true, dropReasoning: true, allowUnchanged: true };
      break;
    case 'session_binding_invalidated':
      codexHistory = true;
      options = { stripItemIds: true, stripReasoningIds: true };
      break;
    case 'account_reasoning_unavailable':
    case 'stale_reasoning_item':
      options = { stripItemIds: codexHistory, dropReasoning: true };
      break;
    case 'azure_resource_mismatch':
      options = { stripItemIds: true, dropReasoning: true };
      break;
    case 'empty_stream_shape':
    case 'empty_stream_reasoning':
      codexHistory = false;
      options = { stripItemIds: true, stripReasoningIds: true, stripMessageType: true,
        dropReasoning: purpose === 'empty_stream_reasoning' };
      break;
    case 'uncovered_error_fallback':
      options = { stripItemIds: true, dropReasoning: true, requireCompleteTools: true };
      break;
    default:
      throw new Error(`Unknown history repair purpose: ${purpose}`);
  }
  const {
    stripItemIds = false, stripReasoningIds = false, stripMessageType = false,
    dropReasoning = false, allowUnchanged = false, requireCompleteTools = false,
  } = options;
  // Removing both handle sets may retain the complete reasoning payload; only
  // the explicit binding-error recovery opts into that combination.
  const statelessSearch = codexHistory && stripItemIds && (dropReasoning || stripReasoningIds);
  const handlesOnly = codexHistory && stripReasoningIds && !dropReasoning;
  const completeTools = codexHistory || requireCompleteTools;
  let obj;
  try { obj = JSON.parse(bodyBuf.toString('utf8')); }
  catch { return { error: 'request is not valid JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'request is not a JSON object' };
  if (obj.previous_response_id != null && obj.previous_response_id !== '') {
    return { error: 'previous_response_id references server-side history; complete inline history cannot be verified' };
  }
  if (obj.conversation != null) return { error: 'conversation references server-side history' };
  if (!Array.isArray(obj.input)) return { error: 'input is not a complete inline item array' };
  // Never remove reasoning while retaining resource-bound search handles.
  if (codexHistory && dropReasoning && !statelessSearch && obj.input.some(item => item?.type === 'web_search_call')) {
    return { error: 'web_search_call may depend on reasoning; refusing to discard its history' };
  }

  let removedReasoning = 0;
  let removedIds = 0;
  let removedTypes = 0;
  const input = [];
  const calls = new Map();
  const completedCalls = new Set();
  for (const item of obj.input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'unsupported inline input item' };
    if (item.type === 'item_reference') return { error: 'item_reference requires server-side history; refusing to discard it' };
    if (item.type === 'reasoning') {
      if (dropReasoning) { removedReasoning++; continue; }
      if (handlesOnly && Object.hasOwn(item, 'id') && !nonEmptyStr(item.encrypted_content)) {
        return { error: 'reasoning handle lacks inline encrypted content; refusing to discard its reference' };
      }
      if (stripReasoningIds && Object.hasOwn(item, 'id')) {
        delete item.id;
        removedIds++;
      }
      input.push(item);
      continue;
    }
    if (item.type === 'message' || (item.type === undefined && typeof item.role === 'string')) {
      if (!['user', 'assistant', 'system', 'developer'].includes(item.role)
          || !(typeof item.content === 'string' || Array.isArray(item.content))) {
        return { error: 'message does not contain inline role/content' };
      }
      if (handlesOnly && Object.hasOwn(item, 'id')
          && (typeof item.content === 'string' ? !item.content.trim() : !item.content.length)) {
        return { error: 'empty message may reference server-side content; refusing to discard its handle' };
      }
      if (stripMessageType && Object.hasOwn(item, 'type')) {
        delete item.type;
        removedTypes++;
      }
    } else if (item.type === 'agent_message') {
      if (!nonEmptyStr(item.author) || !nonEmptyStr(item.recipient)
          || !(nonEmptyStr(item.content) || Array.isArray(item.content) && item.content.length > 0)) {
        return { error: 'agent_message does not contain inline author/recipient/content' };
      }
    } else if (item.type === 'function_call') {
      if (!nonEmptyStr(item.call_id) || !nonEmptyStr(item.name) || typeof item.arguments !== 'string'
          || calls.has(item.call_id)) return { error: 'function_call is incomplete or has a duplicate call_id' };
      calls.set(item.call_id, 'function_call');
    } else if (item.type === 'function_call_output') {
      if (!nonEmptyStr(item.call_id) || calls.get(item.call_id) !== 'function_call'
          || (completeTools && completedCalls.has(item.call_id))
          || !(typeof item.output === 'string' || Array.isArray(item.output))) {
        return { error: 'function_call_output lacks a preceding inline function_call or complete output' };
      }
      if (completeTools) completedCalls.add(item.call_id);
    } else if (item.type === 'custom_tool_call') {
      if (!nonEmptyStr(item.call_id) || !nonEmptyStr(item.name) || typeof item.input !== 'string'
          || calls.has(item.call_id)) return { error: 'custom_tool_call is incomplete or has a duplicate call_id' };
      calls.set(item.call_id, 'custom_tool_call');
    } else if (item.type === 'custom_tool_call_output') {
      if (!nonEmptyStr(item.call_id) || calls.get(item.call_id) !== 'custom_tool_call'
          || (completeTools && completedCalls.has(item.call_id))
          || !(typeof item.output === 'string' || Array.isArray(item.output))) {
        return { error: 'custom_tool_call_output lacks a preceding inline custom_tool_call or complete output' };
      }
      if (completeTools) completedCalls.add(item.call_id);
    } else if (codexHistory && item.type === 'web_search_call') {
      const action = item.action;
      if ((!statelessSearch && !nonEmptyStr(item.id)) || !['in_progress', 'searching', 'completed', 'failed'].includes(item.status)
          || !action || typeof action !== 'object' || Array.isArray(action)
          || !(action.type === 'search' && (nonEmptyStr(action.query)
                || Array.isArray(action.queries) && action.queries.length > 0 && action.queries.every(nonEmptyStr))
            || action.type === 'open_page' && nonEmptyStr(action.url)
            || action.type === 'find_in_page' && nonEmptyStr(action.url) && nonEmptyStr(action.pattern))) {
        return { error: 'web_search_call lacks a supported complete inline action' };
      }
      // The tested Codex route accepts an id-less search in the lossy fallback.
      // Preserve all action extensions; never manufacture call_id or convert to text.
    } else {
      return { error: 'unsupported or reference-only input item; safe replay cannot be verified' };
    }
    if (Object.hasOwn(item, 'encrypted_content')) {
      return { error: 'encrypted_content on a non-reasoning item cannot be safely removed' };
    }
    if (stripItemIds && (!(codexHistory && item.type === 'web_search_call') || statelessSearch) && Object.hasOwn(item, 'id')) {
      delete item.id;
      removedIds++;
    }
    input.push(item);
  }
  if (completeTools && completedCalls.size !== calls.size) {
    return { error: 'inline tool history is incomplete; a call lacks its output' };
  }
  if (!input.length) return { error: 'no inline message or function history would remain' };
  if (!removedReasoning && !removedIds && !removedTypes) {
    if (allowUnchanged) return { body: bodyBuf, removedReasoning: 0, removedIds: 0, removedTypes: 0 };
    return { error: 'no safely removable resource-bound items or item ids' };
  }
  obj.input = input;
  return { body: Buffer.from(JSON.stringify(obj), 'utf8'), removedReasoning, removedIds, removedTypes };
}

// Optional resource handles only. web_search_call ids are required references and
// item_reference carries its id as payload, so neither may be touched.
const CODEX_STRIPPABLE_ID_TYPES = new Set([
  'message', 'reasoning', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output',
]);

/**
 * Proactive Codex sanitizer: drop optional item-id handles before the first upstream
 * attempt. Content, call_id, tool output and reasoning encrypted_content are never
 * modified; the reasoning items themselves are kept.
 */
function stripCodexItemIds(bodyBuf) {
  let obj;
  try { obj = JSON.parse(bodyBuf.toString('utf8')); }
  catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!Array.isArray(obj.input)) return null;
  // Search ids can reference reasoning ids implicitly; the dependency is not exposed
  // in the input, so preserve every reasoning handle when search history is present.
  const hasWebSearch = obj.input.some(item => item?.type === 'web_search_call');
  let removedIds = 0;
  for (const item of obj.input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = item.type === undefined && typeof item.role === 'string' ? 'message' : item.type;
    if (!CODEX_STRIPPABLE_ID_TYPES.has(type) || (hasWebSearch && type === 'reasoning')) continue;
    if (Object.hasOwn(item, 'id')) {
      delete item.id;
      removedIds++;
    }
  }
  if (!removedIds) return null;
  return { body: Buffer.from(JSON.stringify(obj), 'utf8'), removedIds };
}

// Store only scoped hashes, never credentials, session names, or reasoning payloads.
const compatibilityKeys = new Map();
// Codex fallback entries must neither affect nor evict the other clients' entries.
const codexCompatibilityKeys = new Map();
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
function compatibilityIdentity(bodyBuf, headers, enabled = cfg.sessionCompat) {
  if (!enabled) return null;
  let obj;
  try { obj = JSON.parse(bodyBuf.toString('utf8')); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const session = headers['x-relay-session-id'];
  const explicit = typeof session === 'string' && session.length > 0 && session.length <= 512 ? session : '';
  const scope = fingerprint(JSON.stringify([
    cfg.upstream, headers.authorization || '', headers['x-api-key'] || '',
    headers['api-key'] || '', obj.model || '', explicit,
  ]));
  if (explicit) return { keys: [fingerprint(scope + ':session')], source: 'explicit_session' };
  const keys = [];
  if (Array.isArray(obj.input)) {
    for (const item of obj.input) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      if (!['reasoning', 'message', 'function_call', 'function_call_output'].includes(item.type) &&
          !(item.type === undefined && typeof item.role === 'string')) continue;
      for (const field of item.type === 'reasoning' ? ['id', 'encrypted_content'] : ['id']) {
        if (nonEmptyStr(item[field])) keys.push(fingerprint(scope + ':' + field + ':' + item[field]));
      }
    }
  }
  return keys.length ? { keys: [...new Set(keys)], source: 'resource_lineage' } : null;
}

function pruneCompatibility(cache) {
  const now = Date.now();
  for (const [key, expiry] of cache) if (expiry <= now) cache.delete(key);
}

function knownCompatibility(identity, cache) {
  pruneCompatibility(cache);
  return !!identity && identity.keys.some((key) => cache.has(key));
}

function rememberCompatibility(identity, cache) {
  if (!identity) return false;
  pruneCompatibility(cache);
  for (const key of identity.keys) {
    cache.delete(key);
    cache.set(key, Date.now() + cfg.sessionCompatTtlMs);
    while (cache.size > cfg.sessionCompatMaxKeys) {
      cache.delete(cache.keys().next().value);
    }
  }
  return true;
}

/**
 * 配额/余额类错误（HTTP 402 或特定文案）：
 * 例如 "Budget pool quota has been exhausted" —— 账户或共享池没额度了。
 * 重试在单个请求内毫无意义（池子不会几秒内回血），必须快速失败并让用户看到真实原因，
 * 好去换模型/换号/等池子恢复。若当成可重试错误处理，只会白白拖慢并烧掉请求数。
 */
const QUOTA_TEXT =
  /\b(?:budget pool|quota has been exhausted|quota exhausted|insufficient_quota|insufficient quota|out of quota|exceeded your current quota|no available channel|payment required|insufficient balance|balance (?:is )?(?:insufficient|exhausted|too low))\b|余额不足|额度不足|配额/i;

function isQuotaError(info) {
  return !!info && (QUOTA_CODES.has(String(info.code || info.type || '').toLowerCase())
    || QUOTA_TEXT.test(errorCauseText(info.message)));
}

const DETERMINISTIC_BODY_TEXT =
  /\b(?:sensitive words|sensitive_words|content[-_ ]?(?:blocked|filter)|flagged|moderation|model not found|(?:model|resource|item)\s+(?:['"][^'"\r\n]+['"]\s+)?does not exist|invalid model|unsupported model|not supported|too large|context length|context_length_exceeded|maximum context|exceed\w*[^.\r\n]*\bmax(?:imum)?[^.\r\n]*\btokens?)\b|内容审核|违规/i;

function isDeterministicError(info) {
  return !!info && (isPermanentError(info) || isQuotaError(info)
    || DETERMINISTIC_BODY_TEXT.test(errorCauseText(info.message)));
}

const snippet = (b) => String(b).replace(/\s+/g, ' ').slice(0, 160);

/**
 * 按请求体大小决定「等待上游响应头」允许多久。
 * 小请求 30s（快速失败、换通道重试很划算）；
 * 大请求即长上下文，预填充本来就慢，按每 MB 放宽，上限为总预算。
 */
function connectTimeoutFor(bodyBytes, totalBudgetMs = cfg.totalBudgetMs, connectTimeoutMs = cfg.connectTimeoutMs) {
  const mb = Math.max(0, bodyBytes) / (1024 * 1024);
  const scaled = connectTimeoutMs + mb * cfg.connectTimeoutPerMbMs;
  return Math.max(1000, Math.min(totalBudgetMs, scaled));
}

/**
 * undici 抛的 `fetch failed` 本身没有信息量，真正的原因藏在 error.cause 里
 * （ECONNRESET / ETIMEDOUT / ENOTFOUND / UND_ERR_SOCKET ...）。
 * 逐层展开，方便判断是中转站抖动、DNS 问题还是本机网络问题。
 */
function describeFetchError(e) {
  const parts = [];
  let cur = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const bits = [cur.name, cur.code, cur.message].filter((x) => typeof x === 'string' && x && x !== parts.at(-1));
    if (bits.length) parts.push(bits.join('/'));
    cur = cur.cause;
  }
  return parts.join(' <- ') || 'unknown fetch error';
}

// 只在需要重试时创建计时器；取消立即结束等待，不等下一轮才收尾。
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const finish = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal.addEventListener('abort', finish, { once: true });
});
const backoffMs = (attempt, policy = cfg) =>
  Math.min(policy.maxDelayMs, Math.round(policy.baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.3)));

function joinUrl(origin, path) {
  const o = origin.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  if (o.endsWith('/v1') && p.startsWith('/v1/')) return o + p.slice(3);
  return o + p;
}

// ── 错误识别 ────────────────────────────────────────────────────────────────

/**
 * 是否为「终止事件」—— 流正常结束的标志。
 * 缺少它说明上游把流截断了（CC Switch 会报
 * "Responses upstream stream ended before a terminal event"）。
 */
const RESPONSES_TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete']);

/**
 * 上游「静默丢弃」：HTTP 200，只回显 response.created（约 180KB，含 tools 回显）就关流，
 * 既不报错也不生成内容。这类失败没有可识别的错误文案，状态修复与推理项修复都不会触发，
 * 早先只能落进泛化重试 —— 用同一份请求体反复重试，指数退避光睡觉就要约 30 秒。
 */
const EMPTY_STREAM_DROP = 'empty response (stream ended with no content)';
function isTerminalEvent(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj.type;
  if (typeof t === 'string') {
    if (RESPONSES_TERMINAL.has(t)) return true;
    if (t === 'message_stop') return true;            // Anthropic
  }
  // OpenAI Chat Completions：出现 finish_reason 即已终结
  if (Array.isArray(obj.choices) && obj.choices.some((c) => c && c.finish_reason)) return true;
  return false;
}

function errorInfoFromJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const eventError = obj.type === 'error' || obj.type === 'response.failed';
  const e = obj.error || (eventError ? obj.response?.error : null);
  if (!eventError && (!e || typeof e !== 'object' || Array.isArray(e))) return null;
  const field = value => typeof value === 'string' && value.trim() ? value : undefined;
  const code = field(e?.code) || (eventError ? field(obj.code) : undefined);
  const type = field(e?.type);
  const message = field(e?.message) || (eventError ? field(obj.message) : undefined);
  return { code, type, message: message || 'provider error',
    structured: true, hasDetails: !!(code || type || message) };
}

function isRetryableError(info) {
  if (!info) return false;
  if (RETRYABLE_CODES.has(String(info.code || info.type || '').toLowerCase())) return true;
  return RETRYABLE_TEXT.test(errorCauseText(info.message));
}

// Every error carrier supplies the same evidence. Transport status is authoritative
// for auth/payment; generic envelope types and unrelated JSON are not error causes.
function classifyError(info, status = 200) {
  const message = errorCauseText(info?.message);
  const evidence = info ? { code: info.code, type: info.type, message } : null;
  let quota = status === 402 || isQuotaError(evidence);
  let permanent = quota || status === 401 || status === 403 || isDeterministicError(evidence);
  let deployment = !permanent && isDeploymentError(evidence);
  let retryable = !permanent && (deployment || status === 408 || status === 429 || status >= 500 || isRetryableError(info));
  let kind = permanent ? (quota ? 'quota' : 'permanent') : deployment ? 'deployment' : retryable ? 'retryable' : 'unknown';
  const sessionBindingInvalidated = kind === 'unknown' && [200, 400, 409].includes(status)
    && (String(info?.code || '').toLowerCase() === 'session_binding_invalidated'
      || /\bsession binding invalidated\b[\s\S]*\bnew session id\b/i.test(message));
  const accountReasoningUnavailable = [200, 400, 409].includes(status)
    && ACCOUNT_REASONING_BOUND_TEXT.test(message) && WITHOUT_ENCRYPTED_REASONING_TEXT.test(message);
  let historyKind = null;
  let missingSearchReasoning = false;
  let statusIndex = null;
  if (kind === 'unknown' && info && (status === 400 || status === 200)) {
    const statusMatch = /^Unknown parameter: ['"]input\[(\d+)\]\.status['"]\.(?:\s*\[trace_id=[^\]\r\n]+\])?\s*$/.exec(message);
    if (statusMatch) {
      kind = 'status';
      statusIndex = Number(statusMatch[1]);
    } else {
      const azure = isAzureResourceError(message);
      const reasoning = isReasoningItemError(message);
      missingSearchReasoning = !azure && !reasoning && MISSING_SEARCH_REASONING_TEXT.test(message);
      if (azure || reasoning || missingSearchReasoning) {
        kind = 'history';
        historyKind = azure ? 'azure_resource_mismatch' : 'stale_reasoning_item';
      }
    }
  }
  // This message contains "unavailable", so it would otherwise be a generic retryable
  // error. Only the two explicit phrases together (and only on 200/400/409) enter the
  // bounded history repair; ordinary 503/429 wording never changes the request body.
  if (accountReasoningUnavailable) {
    kind = 'history';
    historyKind = 'account_reasoning_unavailable';
    permanent = false;
    quota = false;
    retryable = false;
    deployment = false;
  }
  return { kind, info, message, permanent, quota, deployment, retryable, historyKind, missingSearchReasoning, statusIndex, sessionBindingInvalidated };
}

// Strong non-history evidence excludes the fallback; generic "not supported" or
// "unavailable" alone does not. Keep the established classifier unchanged.
const FALLBACK_HARD_TEXT = /\b(?:sensitive words|content[-_ ]?(?:blocked|filter)|flagged|moderation|model not found|invalid model|unsupported model|too large|context length|context_length_exceeded|maximum context|exceed\w*[^.\r\n]*\bmax(?:imum)?[^.\r\n]*\btokens?)\b|\bmodel\b[^.\r\n]{0,120}\b(?:not supported|does not exist)\b|内容审核|违规/i;
const FALLBACK_TRANSIENT_TEXT = /\b(?:rate[ _-]?limit|too many requests|tokens? per minute|requests? per minute|overload(?:ed)?|high demand|capacity|timeout|timed out|bad gateway|internal (?:server )?error|network error|connection (?:failed|reset)|(?:service|server|gateway)(?: is)?(?: temporarily)? unavailable)\b|\b(?:HTTP(?: status(?: code)?)?|status(?: code)?|error(?: code)?)\s*[:=]?\s*(?:408|429|502|503|504)\b/i;
function fallbackHardKind(info, status) {
  const codes = [info?.code, info?.type].map(value => String(value || '').toLowerCase());
  const message = errorCauseText(info?.message);
  const reportedStatus = Number(/\b(?:HTTP(?: status(?: code)?)?|status(?: code)?|error(?: code)?)\s*[:=]?\s*(\d{3})\b/i.exec(message)?.[1]);
  if (status === 402 || reportedStatus === 402 || codes.some(code => QUOTA_CODES.has(code)) || QUOTA_TEXT.test(message)) return 'quota';
  if ([401, 403, 413].includes(status) || [401, 403, 413].includes(reportedStatus) || codes.some(code => PERMANENT_CODES.has(code)
      || ['forbidden', 'invalid_model_id'].includes(code))
      || PERMANENT_TEXT.test(message) || FALLBACK_HARD_TEXT.test(message)) return 'permanent';
  return null;
}
function isUncoveredFallbackError(failure) {
  const { classification, status, source, kind } = failure;
  const info = classification.info;
  if (!info || info.hasDetails === false || fallbackHardKind(info, status)) return false;
  if (classification.kind === 'history' || classification.kind === 'status'
      || classification.sessionBindingInvalidated || classification.deployment) return false;
  if (source === 'sse_precommit' && kind !== 'stream_error') return false;
  if (status === 200) {
    if (!info.structured) return false;
  } else if ([404, 500].includes(status)) {
    if (!info.structured) return false;
  } else if (![400, 409, 422].includes(status)) return false;
  const message = errorCauseText(info.message);
  if (!message.trim() || /<\/?(?:html|head|body)\b|<!doctype\b/i.test(message)) return false;
  const codes = [info.code, info.type].map(value => String(value || '').toLowerCase());
  if (codes.some(code => (code !== 'upstream_error' && RETRYABLE_CODES.has(code))
      || code === 'rate_limit_error' || cfg.extraRetryCodes.includes(code))) return false;
  return !FALLBACK_TRANSIENT_TEXT.test(message) && !DEPLOYMENT_TEXT.test(message);
}

// 诊断用：把上游错误压成有界的指纹（错误码 + 命中的关键词），绝不落盘原文。
// 上游错误文案会随中转站改动，指纹让我们能判断「某个已知类别换了说法」还是「新类别」。
const ERROR_HINTS = ['different', 'resource', 'masked', 'persisted', 'encrypted', 'not found',
  'rate', 'overload', 'capacity', 'quota', 'channel', 'balance', 'timeout', 'unavailable', 'deployment'];
function errorFingerprint(info) {
  if (!info) return null;
  const message = errorCauseText(info.message).toLowerCase();
  const code = String(info.code || '');
  return {
    code: /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : (code ? 'other' : 'none'),
    hints: ERROR_HINTS.filter((h) => message.includes(h)).join(','),
    masked: message.includes('***'),
  };
}

const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
function responsePartHasContent(part) {
  if (part?.type === 'output_text') return nonEmptyStr(part.text);
  if (part?.type === 'refusal') return nonEmptyStr(part.refusal);
  return true; // 未知载荷保守交付，不能把可能的真实输出当作空占位重放。
}

/**
 * 该事件是否携带「真实内容」。只有它出现，才认为上游确实开始正常回复。
 *
 * 必须同时支持两种协议，否则会把另一种协议的健康流误判成「空响应」：
 *   - OpenAI 风格：choices[].delta.content / tool_calls
 *   - Anthropic 风格：content_block_delta（text_delta / thinking_delta / input_json_delta）
 */
function contentBearing(obj, codexResponses = false) {
  if (!obj || typeof obj !== 'object') return false;

  // ── OpenAI / OpenAI 兼容 ──
  for (const choice of Array.isArray(obj.choices) ? obj.choices : []) {
    if (!choice) continue;
    const d = choice.delta ?? choice.message ?? {};
    if (nonEmptyStr(d.content)) return true;
    if (nonEmptyStr(d.reasoning_content) || nonEmptyStr(d.reasoning)) return true;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) return true;
    // finish_reason 单独出现（无内容）不算内容 —— 那正是「空回应」的特征
  }

  const t = String(obj.type || '');

  // ── Anthropic 风格 ──
  if (t === 'content_block_delta') {
    const d = obj.delta || {};
    // text_delta.text / thinking_delta.thinking / input_json_delta.partial_json
    if (nonEmptyStr(d.text) || nonEmptyStr(d.thinking) || nonEmptyStr(d.partial_json)) return true;
    if (d.type === 'text_delta' || d.type === 'thinking_delta' || d.type === 'input_json_delta') return true;
    return false;
  }
  if (t === 'content_block_start') {
    const cb = obj.content_block || {};
    if (nonEmptyStr(cb.text) || nonEmptyStr(cb.thinking)) return true;
    // tool_use / server_tool_use 刚开块时就算有内容在路上了
    if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'web_search_tool_result') return true;
    return false;
  }
  // 这些是 Anthropic 的边界/结束事件，本身不含内容
  if (t === 'message_start' || t === 'message_delta' || t === 'message_stop'
      || t === 'content_block_stop' || t === 'ping') return false;

  // ── OpenAI Responses 风格 ──
  if (t === 'response.completed') return true;
  if (t.endsWith('.delta') && nonEmptyStr(obj.delta)) return true;
  if (t === 'response.output_item.added' && obj.item?.type === 'reasoning') {
    const item = obj.item;
    return nonEmptyStr(item.encrypted_content) || [item.summary, item.content].some((parts) =>
      parts != null && (!Array.isArray(parts) || parts.some((part) =>
        !['summary_text', 'reasoning_text'].includes(part?.type) || nonEmptyStr(part.text))));
  }
  if (t === 'response.output_item.added' && obj.item?.type === 'message') {
    const parts = obj.item.content;
    return parts != null && (!Array.isArray(parts) || parts.some(responsePartHasContent));
  }
  if (t === 'response.content_part.added') return responsePartHasContent(obj.part);
  // 未进入前置缓冲的搜索结果保持原保守交付边界。
  if (codexResponses && t === 'response.output_item.done' && obj.item?.type === 'web_search_call') return true;
  if (t === 'response.output_item.added') return true;

  if (nonEmptyStr(obj.content) || nonEmptyStr(obj.text)) return true;

  return false;
}

function encryptedReasoningOnly(obj) {
  if (!['response.output_item.added', 'response.output_item.done'].includes(obj?.type)
      || obj.item?.type !== 'reasoning' || !nonEmptyStr(obj.item.encrypted_content)) return false;
  return [obj.item.summary, obj.item.content].every(parts => parts == null
    || (Array.isArray(parts) && parts.every(part =>
      ['summary_text', 'reasoning_text'].includes(part?.type) && !nonEmptyStr(part.text))));
}

function responsePreludeKind(obj) {
  if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(obj.type)
      && typeof obj.delta === 'string') return 'reasoning';
  if (['response.reasoning_summary_text.done', 'response.reasoning_text.done'].includes(obj.type)
      && typeof obj.text === 'string') return 'reasoning';
  if (['response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
    'response.content_part.added'].includes(obj.type)
      && ['summary_text', 'reasoning_text'].includes(obj.part?.type)
      && (obj.part.text == null || typeof obj.part.text === 'string')) return 'reasoning';
  if (['response.output_item.added', 'response.output_item.done'].includes(obj.type)
      && obj.item?.type === 'reasoning') {
    const parts = [obj.item.summary, obj.item.content];
    const known = parts.every(list => list == null || (Array.isArray(list) && list.every(part =>
      ['summary_text', 'reasoning_text'].includes(part?.type)
        && (part.text == null || typeof part.text === 'string'))));
    if (known && (nonEmptyStr(obj.item.encrypted_content)
        || parts.some(list => Array.isArray(list) && list.some(part => nonEmptyStr(part.text))))) return 'reasoning';
  }
  if (['response.web_search_call.in_progress', 'response.web_search_call.searching',
    'response.web_search_call.completed'].includes(obj.type)) return 'search';
  if (['response.output_item.added', 'response.output_item.done'].includes(obj.type)
      && obj.item?.type === 'web_search_call'
      && (['in_progress', 'searching', 'completed', 'failed'].includes(obj.item.status)
          || (obj.type === 'response.output_item.added' && obj.item.status == null))) return 'search';
  return null;
}

function nativePreludeKind(obj, blocks) {
  if (!Number.isInteger(obj.index)) return null;
  if (obj.type === 'content_block_start') {
    blocks.delete(obj.index);
    const block = obj.content_block;
    if ((block?.type === 'server_tool_use' && block.name === 'web_search')
        || block?.type === 'web_search_tool_result') blocks.set(obj.index, 'search');
    else if (['thinking', 'redacted_thinking'].includes(block?.type)) blocks.set(obj.index, 'reasoning');
    return blocks.get(obj.index) || null;
  }
  const kind = blocks.get(obj.index);
  if (obj.type === 'content_block_stop') { blocks.delete(obj.index); return kind || null; }
  if (obj.type === 'content_block_delta'
      && ((kind === 'search' && obj.delta?.type === 'input_json_delta')
          || (kind === 'reasoning' && ['thinking_delta', 'signature_delta'].includes(obj.delta?.type)))) return kind;
  return null;
}

function searchCompletionKey(obj) {
  if (obj.type === 'response.web_search_call.completed'
      || (obj.type === 'response.output_item.done' && obj.item?.type === 'web_search_call'
          && obj.item.status === 'completed')) {
    return 'responses:' + String(obj.item_id ?? obj.item?.id ?? obj.output_index ?? 'completed');
  }
  if (obj.type === 'content_block_start' && obj.content_block?.type === 'web_search_tool_result') {
    return 'messages:' + String(obj.content_block.tool_use_id ?? obj.index);
  }
  return null;
}

/** 非流式响应是否为「空回应」 */
function isEmptyCompletion(obj) {
  if (!obj || typeof obj !== 'object') return false;

  // ── Anthropic 风格：{ content: [{type:'text',text:'...'}, ...] } ──
  if (Array.isArray(obj.content) && obj.choices === undefined) {
    if (obj.content.length === 0) return true;
    const hasContent = obj.content.some((b) =>
      nonEmptyStr(b?.text) || nonEmptyStr(b?.thinking)
      || b?.type === 'tool_use' || b?.type === 'server_tool_use');
    return !hasContent;
  }

  // ── OpenAI / OpenAI 兼容 ──
  const c = obj.choices?.[0];
  if (!c) return false;
  const m = c.message ?? c.delta ?? {};
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
  if (nonEmptyStr(m.reasoning_content) || nonEmptyStr(m.reasoning)) return false;
  return !nonEmptyStr(m.content);
}

/** 解析一段 SSE 原始文本里的 data: 负载 */
function ssePayload(rawEvent) {
  const data = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;               // 注释 / 心跳
  const joined = data.join('\n');
  if (joined.trim() === '[DONE]') return { done: true };
  if (joined.startsWith('{')) {
    try { return { obj: JSON.parse(joined) }; } catch { return { obj: null }; }
  }
  try { return { obj: JSON.parse(joined) }; } catch { return { obj: null }; }
}

async function readWithTimeout(reader, ms) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IDLE_TIMEOUT')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

// ── 响应输出 ────────────────────────────────────────────────────────────────

function passthrough(res, status, headers, buf) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'x-relay-request-id'].includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  res.writeHead(status, out);
  res.end(buf);
}

/**
 * 本地重试已耗尽：改写为 ZCode 认得的可重试状态。
 * attempts 为实际发起过的尝试次数（预算/连接失败会提前收手，可能小于 cfg.maxAttempts），
 * 只有拿不到真实次数时才回退到配置上限。type/code 保持可重试标识，不改变客户端重试行为。
 */
function sendRetryable(res, status, reason, attempts, policy = cfg) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  const used = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : policy.maxAttempts;
  const payload = JSON.stringify({
    error: {
      message: `relay-retry-proxy: local retry exhausted after ${used} attempts (${reason})`,
      type: 'too_many_requests',
      code: 'rate_limit_exceeded',
    },
  });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'retry-after': String(Math.max(1, Math.round(policy.baseDelayMs / 1000))),
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 不可重试的错误：把真实原因回给 ZCode。status 用 402(配额)/400(其余) 便于区分。 */
function sendPermanent(res, reason, status = 400) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  const payload = JSON.stringify({
    error: { message: `relay-retry-proxy: 不可重试的错误（${reason}）`, type: 'invalid_request_error', code: 'invalid_request_error' },
  });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ── 流式：先窥探，确认有真实内容再下发 ──────────────────────────────────────

function completedReasoningProgress(obj, seen) {
  if (obj.type !== 'response.output_item.done' || obj.item?.type !== 'reasoning') return false;
  const item = obj.item;
  const parts = [];
  if (nonEmptyStr(item.encrypted_content)) parts.push(['encrypted_content', item.encrypted_content]);
  for (const [field, type] of [['summary', 'summary_text'], ['content', 'reasoning_text']]) {
    if (!Array.isArray(item[field])) continue;
    for (const part of item[field]) {
      if (part?.type === type && nonEmptyStr(part.text)) parts.push([field, part.text]);
    }
  }
  if (!parts.length) return false;
  const contentKey = 'content:' + fingerprint(JSON.stringify(parts));
  const idKey = nonEmptyStr(item.id) ? 'id:' + fingerprint(item.id) : null;
  const repeated = seen.has(contentKey) || (idKey && seen.has(idKey));
  // Keep the deduplication set bounded without evicting old entries that could replay.
  if (seen.size + (idKey ? 2 : 1) > 65536) return false;
  seen.add(contentKey);
  if (idKey) seen.add(idKey);
  return !repeated;
}

function generationProgress(obj, seenReasoning) {
  if (!obj || typeof obj !== 'object') return false;
  if (completedReasoningProgress(obj, seenReasoning)) return true;
  for (const choice of Array.isArray(obj.choices) ? obj.choices : []) {
    const delta = choice?.delta;
    if (!delta) continue;
    if ([delta.content, delta.reasoning_content, delta.reasoning].some(nonEmptyStr)) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) => nonEmptyStr(call?.function?.name) || nonEmptyStr(call?.function?.arguments))) return true;
  }
  if (obj.type === 'content_block_delta') {
    return [obj.delta?.text, obj.delta?.thinking, obj.delta?.partial_json].some(nonEmptyStr);
  }
  if (obj.type === 'content_block_start') {
    const block = obj.content_block;
    return [block?.text, block?.thinking, block?.name].some(nonEmptyStr);
  }
  if (typeof obj.type === 'string' && obj.type.startsWith('response.') && obj.type.endsWith('.delta')) {
    return nonEmptyStr(obj.delta);
  }
  if (obj.type === 'response.output_item.added') {
    return obj.item?.type === 'function_call' && nonEmptyStr(obj.item?.name);
  }
  return false;
}

async function peekAndCommit(upstream, res, onCommit = () => {}, state, codexResponses = false, bufferPrelude = false) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const buffered = [];
  let bufferedBytes = 0;
  let committed = false;
  let bufferedSearch = false;
  let bufferedReasoning = false;
  let sawTerminal = false;
  let terminalKind = null;   // 固定枚举，诊断用：区分正常完成与 failed / incomplete
  let idleAfterCommit = false;
  let stallReason = null;
  let lastProgress = Date.now();
  const deadline = lastProgress + cfg.peekTotalMs;
  let streamError = null;
  let reachedEof = false;
  let stopReading = false;
  const seenReasoning = new Set();
  const seenSearches = new Set();
  const nativeBlocks = new Map();
  const responseStream = state.path === '/v1/responses';

  const commit = async () => {
    committed = true;
    lastProgress = Date.now();
    observeRequest(state, 'firstContent');
    onCommit();
    state.phase = 'stream_waiting';
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    for (const chunk of buffered) await res.write(chunk);
    buffered.length = 0;
  };
  // kind 是机器可读的失败类别，调用方据此决定要不要换通道 / 做形状修复。
  // 不要用格式化后的 reason 字符串去匹配：那种判断很脆，之前就因此把 peek 超时
  // 误当成「通道抖动」而放宽了尝试次数，覆盖了用户配置的上限。
  const failure = (reason, kind = 'other') => ({
    committed: false, reason, kind, errorMessage: streamError?.message,
    errorCode: streamError?.code || streamError?.type || null,
    classification: classifyError(streamError),
  });

  try {
    while (!stopReading) {
      const remaining = (committed || bufferedSearch || bufferedReasoning ? lastProgress + cfg.streamProgressMs : deadline) - Date.now();
      if (remaining <= 0) {
        if (!committed) return failure('timed out waiting for first content (empty/stalled)', 'peek_timeout');
        stallReason = 'progress_timeout';
        break;
      }
      const idleMs = committed || bufferedSearch || bufferedReasoning ? cfg.streamIdleMs : cfg.peekIdleMs;
      let chunk;
      try {
        chunk = await readWithTimeout(reader, Math.min(idleMs, remaining));
      } catch (e) {
        if (!committed) {
          // 上游「粗暴断连」（不发 FIN 直接销毁 socket）与「正常关流」是同一种静默丢弃：
          // 都是 HTTP 200、只回显 response.created 就没了下文。此前这里返回的
          // `stream read timeout (terminated)` 与 EMPTY_STREAM_DROP 不相等，导致换通道
          // 与请求修复的分支永远进不去 —— 生产诊断里该修复 0 次触发。
          // 只有我们自己设的空闲超时（IDLE_TIMEOUT）才算真正的「等不到」。
          if (e.message !== 'IDLE_TIMEOUT') {
            log(`upstream closed the connection before any content (${e.message})`);
            return failure(EMPTY_STREAM_DROP, 'empty_stream_drop');
          }
          return failure(`stream read timeout (${e.message})`, 'read_timeout');
        }
        idleAfterCommit = true;
        stallReason = res.destroyed ? 'client_closed'
          : e.message === 'IDLE_TIMEOUT' ? (remaining <= idleMs ? 'progress_timeout' : 'transport_idle_timeout')
          : 'upstream_read_error';
        break;
      }
      if (chunk.done) { reachedEof = true; break; }
      const raw = Buffer.from(chunk.value);
      state.bytesReceived += raw.length;
      state.lastByte = Date.now();
      if (committed) await res.write(raw);
      else {
        buffered.push(raw);
        bufferedBytes += raw.length;
        if (bufferedBytes > cfg.sseBufferMaxBytes) return failure('pre-content stream exceeded buffer limit', 'buffer_limit');
      }
      pending += decoder.decode(raw, { stream: true });
      const sep = /\r?\n\r?\n/;
      let match;
      while ((match = sep.exec(pending))) {
        const event = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const payload = ssePayload(event);
        state.eventCount++;
        if (!payload) continue;
        if (payload.done) {
          if (!committed && (bufferedReasoning || bufferedSearch)) await commit();
          sawTerminal = true; terminalKind = 'done_marker'; stopReading = true; continue;
        }
        if (!payload.obj || typeof payload.obj !== 'object' || Array.isArray(payload.obj)) {
          if (!committed) await commit();
          continue;
        }
        const err = errorInfoFromJson(payload.obj);
        if (payload.obj.usage || payload.obj.response?.usage) observeRequest(state, 'usage', payload.obj);
        if (err && !committed) {
          streamError = err;
          return failure(`HTTP 200 but stream carried error: ${err.code || ''} ${err.message}`, 'stream_error');
        }
        if (isTerminalEvent(payload.obj)) {
          sawTerminal = true;
          // 只记协议级终止类型（固定枚举），绝不落盘上游任意字符串：
          // 这样诊断能区分「正常完成」与 failed / incomplete / [DONE]。
          const terminalType = payload.obj.type;
          terminalKind = RESPONSES_TERMINAL.has(terminalType) ? terminalType
            : terminalType === 'message_stop' ? 'message_stop' : 'chat_finish_reason';
          // Chat finish_reason can precede a usage-only chunk; wait for its [DONE].
          if (RESPONSES_TERMINAL.has(terminalType) || terminalType === 'message_stop') stopReading = true;
        }
        const madeProgress = !err && generationProgress(payload.obj, seenReasoning);
        const preludeKind = bufferPrelude && !committed && !err
          ? (responseStream ? responsePreludeKind(payload.obj) : nativePreludeKind(payload.obj, nativeBlocks)) : null;
        const internalReasoning = bufferPrelude && ((responseStream && encryptedReasoningOnly(payload.obj)) || preludeKind === 'reasoning');
        const internalSearch = preludeKind === 'search';
        const completedSearchKey = internalSearch ? searchCompletionKey(payload.obj) : null;
        const completedSearch = completedSearchKey !== null && !seenSearches.has(completedSearchKey);
        if (completedSearch) seenSearches.add(completedSearchKey);
        if (madeProgress || completedSearch) {
          lastProgress = Date.now();
          state.lastProgress = lastProgress;
        }
        const internalPrelude = internalReasoning || internalSearch;
        if (!committed && !err && internalReasoning) {
          // 已知推理留在本轮缓冲中，生成进展仍独立刷新等待窗口。
          if (!bufferedReasoning && !bufferedSearch) lastProgress = Date.now();
          bufferedReasoning = true;
        }
        const hasContent = !err && !committed && !internalPrelude && contentBearing(payload.obj, codexResponses);
        if (!committed && !err && internalSearch) {
          // 只推迟下发，等待容忍度仍从首次搜索开始沿用旧版已交付流的参数。
          if (!bufferedSearch && !bufferedReasoning) lastProgress = Date.now();
          bufferedSearch = true;
        }
        // 明确终态保留原语义，不能将已结束的搜索或思考当作静默断流。
        const unknownPayload = !internalPrelude && payload.obj.type && !isKnownStreamEvent(payload.obj);
        if (!err && !committed && ((madeProgress && !internalPrelude) || hasContent || unknownPayload || payload.obj.type === 'response.incomplete'
            || ((bufferedSearch || bufferedReasoning) && isTerminalEvent(payload.obj)))) await commit();
        if (madeProgress) {
          state.lastProgress = Date.now();
          const kind = progressKind(payload.obj);
          state.phase = kind === 'reasoning' ? 'reasoning' : kind === 'tool' ? 'tool_output' : 'text_output';
          state[kind === 'reasoning' ? 'reasoningEvents' : kind === 'tool' ? 'toolEvents' : 'textEvents']++;
        }
      }
      // Bound a malformed or unterminated event without buffering the entire stream.
      if (pending.length > cfg.sseBufferMaxBytes) {
        if (!committed) return failure('SSE event exceeded buffer limit', 'buffer_limit');
        stallReason = 'event_size_limit';
        break;
      }
    }
    if (!committed) return failure(EMPTY_STREAM_DROP, 'empty_stream_drop');
    if (stallReason || !sawTerminal) log(`stream ended without successful completion: ${stallReason || 'missing_terminal'}${terminalKind ? ' terminal=' + terminalKind : ''}`);
    res.end();
    return { committed: true, sawTerminal, terminalKind, idleAfterCommit, stallReason };
  } finally {
    // A terminal event does not require the upstream to close its HTTP connection.
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ── 主处理 ──────────────────────────────────────────────────────────────────

export async function handle(req, res, state) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  let repairCount = 0;
  let attemptCount = 0;
  const diagnose = () => {};
  const ac = state.controller;
  const body = state.body;
  const target = req.url;

  const headers = {};
  for (const [k, v] of req.headers) {
    // 原样保留所有客户端特征头（中转站会校验指纹），只丢弃下面这几个逐跳/传输层头：
    //   host / content-length / connection / transfer-encoding —— 由本地重新生成
    //   accept-encoding —— 必须为空，否则上游会压缩，窥探逻辑读不到明文
    //   expect —— 客户端用 `Expect: 100-continue` 做大请求体的预检；请求体已在上面
    //             完整读进内存，不需要这个机制。而 undici 不支持该头，转发会直接抛
    //             UND_ERR_NOT_SUPPORTED（expect header not supported）导致 502。
    if (['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding', 'expect'].includes(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }

  const noBody = req.method === 'GET' || req.method === 'HEAD';
  let lastReason = 'unknown';
  // Unknown histories retain their original bytes until a recognized error.
  let activeBody = body;
  let repairedItems = false; // one shared repair allowance, including legacy reasoning errors
  let preserveResourceHistory = false;
  let preflightRefused = false;
  let repairedStatus = false;
  let resourceFailures = 0;
  let historyRepairRefusal = '';
  const historyErrorCounts = new Map();
  const isResponses = req.method === 'POST' && pathname === '/v1/responses';
  const isMessages = req.method === 'POST' && pathname === '/v1/messages';
  const clientCodex = isResponses && state.caller === 'codex';
  const clientClaude = state.caller === 'claude';
  const bufferPrelude = clientCodex || ((isResponses || isMessages) && clientClaude);
  // Classification must not change when a user disables a recovery action.
  const eligibleCodex = clientCodex;
  const policy = profileFor(eligibleCodex, state.policy);
  const fallbackEnabled = isResponses && (eligibleCodex || clientClaude)
    && policy.historyMode === 'on_error' && policy.uncoveredErrorFallback;
  const fallback = { phase: 'idle', remainingSends: 0 };
  const fallbackSpent = () => fallback.phase === 'applied' && fallback.remainingSends === 0;
  const resetFallbackConfirmation = () => { if (fallback.phase === 'confirming') fallback.phase = 'idle'; };
  const codexResourceRetry = clientCodex && policy.retryHistory;
  let historyRepairChecked = false;
  // 「修复版最多再发三次」只约束本次确实按历史错误做过有损降级的请求。
  // 会话记忆的预清理（首发前就剥离）不构成历史错误证据：实测它覆盖了 Codex 的
  // 全部请求，再叠上这条上限，纯限流也只能试 3 次就放弃（生产一天 83 次，配置的
  // 110 次形同虚设）。没报过历史错误的请求按通用预算重试。
  let historyRepairApplied = false;
  let bindingIdRepairApplied = false;
  let accountReasoningRetries = 0;
  let postRepairSends = 0;
  let frozenHistoryKind = null;
  diagnose('received', isResponses ? { shape: summarizeResponsesBody(body) } : {});
  // Keep Codex fallback memory separate; other clients retain their existing policy.
  const compatibilityCache = eligibleCodex ? codexCompatibilityKeys : compatibilityKeys;
  const compatibility = isResponses ? compatibilityIdentity(body, headers,
    policy.rememberSession && policy.historyMode === 'on_error') : null;
  delete headers['x-relay-session-id'];
  delete headers['x-relay-client'];
  if (isResponses && policy.historyMode === 'always') {
    // Commit the entire candidate or none of it, including the optional ID cleanup.
    // An unsupported reference must keep the caller's original bytes intact.
    const cleaned = repairResponsesItems(body, 'preflight', eligibleCodex);
    if (cleaned.error) {
      preflightRefused = true;
      preserveResourceHistory = true;
      log('policy preflight: unsupported history retained unchanged');
    } else {
      activeBody = cleaned.body;
      repairedItems = !!(cleaned.removedIds || cleaned.removedReasoning);
      historyRepairChecked = eligibleCodex;
      if (repairedItems) repairCount++;
      log(`policy preflight: removed ids=${cleaned.removedIds}, reasoning=${cleaned.removedReasoning}`);
    }
  } else {
    if (clientCodex && policy.stripItemIds) {
      const stripped = stripCodexItemIds(activeBody);
      if (stripped) {
        activeBody = stripped.body;
        diagnose('session_compat_applied', { source: compatibility?.source ?? 'resource_lineage',
          removedReasoning: 0, removedIds: stripped.removedIds });
        log(`codex item ids stripped before first attempt: ${stripped.removedIds}`);
      }
    }
    if (knownCompatibility(compatibility, compatibilityCache)) {
      const cleaned = repairResponsesItems(activeBody, 'session_compat', eligibleCodex);
      if (cleaned.error) {
        diagnose('session_compat_refused', { reason: 'unsafe_inline_history' });
        // A remembered repair is optional for general clients. Let the upstream resolve its own references.
        if (codexResourceRetry) {
          diagnose('codex_session_passthrough', { reason: 'unsafe_inline_history' });
        } else if (clientCodex) {
          return sendPermanent(res, 'Session compatibility requires complete inline message and tool history; server-side references or unsupported items cannot be discarded.');
        }
      } else {
        activeBody = cleaned.body;
        rememberCompatibility(compatibility, compatibilityCache);
        repairedItems = true;
        diagnose('session_compat_applied', { source: compatibility.source,
          removedReasoning: cleaned.removedReasoning, removedIds: cleaned.removedIds });
      }
    }
  }
  // 上限可随着「通道类抖动」动态放宽
  let maxAttempts = policy.maxAttempts;
  const deadline = state.started + policy.totalBudgetMs;
  const outOfBudget = () => Date.now() >= deadline;
  // A capped attempt must not spend another backoff interval before discovering the cap.
  const retrySleep = (ms) => {
    if (fallbackSpent() || (eligibleCodex && historyRepairApplied && postRepairSends >= 3)) return Promise.resolve();
    if (!ac.signal.aborted) state.phase = 'retry_waiting';
    return sleep(ms, ac.signal);
  };
  // 大请求（长对话）要等更久才等到首个响应头
  const attemptTimeoutMs = connectTimeoutFor(body.length, policy.totalBudgetMs, policy.connectTimeoutMs);
  log(`incoming ${req.method} ${req.url} body=${(body.length / 1024).toFixed(0)}KB ` +
      `waitHeader=${Math.round(attemptTimeoutMs / 1000)}s budget=${Math.round(policy.totalBudgetMs / 1000)}s`);

  const handleStatusError = (classification, attempt, source, status) => {
    if (!policy.repairStatus || classification.kind !== 'status') return null;
    const index = classification.statusIndex;
    const refuse = (reason) => {
      diagnose('status_repair_refused', { source, status, reason });
      sendPermanent(res, `Unsupported input status field: ${reason}. Correct the upstream request conversion.`);
      return 'stop';
    };
    if (bindingIdRepairApplied) return refuse('repair_exhausted');
    if (!isResponses) return refuse('wrong_endpoint');
    if (repairedStatus || (eligibleCodex && historyRepairChecked)) return refuse('repair_exhausted');
    if (status !== 400 && status !== 200) return refuse('unexpected_status');
    let obj;
    try { obj = JSON.parse(activeBody.toString('utf8')); }
    catch { return refuse('invalid_json'); }
    const item = Array.isArray(obj?.input) && Number.isSafeInteger(index) ? obj.input[index] : null;
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !['message', 'function_call', 'function_call_output'].includes(item.type) ||
        !Object.hasOwn(item, 'status') || !['completed', 'in_progress', 'incomplete'].includes(item.status)) {
      return refuse('unsupported_item');
    }
    if (deadline - Date.now() < cfg.minRetryWindowMs + cfg.deployDelayMs) return refuse('time_budget');
    // Remove only the explicitly rejected metadata field, never nested tool/user data.
    delete item.status;
    activeBody = Buffer.from(JSON.stringify(obj), 'utf8');
    repairedStatus = true;
    maxAttempts = Math.max(maxAttempts, attempt + 1);
    diagnose('status_repair_applied', { source, status, index });
    return 'retry';
  };

  // Called uniformly for HTTP errors, pre-commit SSE errors and 200 JSON errors.
  const handleItemError = (classification, attempt, source, status) => {
    if (classification.sessionBindingInvalidated && eligibleCodex && policy.historyMode !== 'off') {
      const kind = 'session_binding_invalidated';
      // A retry is useful only with a changed request. Refusal or repeated failure
      // must stop, including SSE/200 error envelopes, rather than discard reasoning.
      classification.permanent = true;
      classification.retryable = false;
      diagnose('item_error', { kind, source, status, shape: summarizeResponsesBody(activeBody) });
      const refuse = (refusal) => {
        diagnose('repair_refused', { kind, source, status, refusal });
        return null;
      };
      if (repairedItems) return refuse('repair_exhausted');
      if (preflightRefused) return refuse('unsafe_inline_history');
      if (deadline - Date.now() < cfg.minRetryWindowMs + cfg.deployDelayMs) return refuse('time_budget');
      const confirmations = (historyErrorCounts.get(kind) || 0) + 1;
      historyErrorCounts.set(kind, confirmations);
      if (confirmations < policy.historyConfirmations) {
        return attempt < maxAttempts ? 'retry' : refuse('time_budget');
      }
      const repaired = repairResponsesItems(activeBody, kind);
      if (repaired.error) return refuse('unsafe_inline_history');
      activeBody = repaired.body;
      bindingIdRepairApplied = true;
      repairedItems = true;
      repairCount++;
      maxAttempts = Math.max(maxAttempts, attempt + 1);
      // Never register this in the old compatibility cache: that cache means
      // dropReasoning on the next request. Client headers/metadata stay untouched.
      diagnose('repair_applied', { kind, source, status, removedIds: repaired.removedIds, removedReasoning: 0 });
      log(`attempt ${attempt}: ${kind}: removed item ids=${repaired.removedIds}; reasoning and client identity retained`);
      return 'retry';
    }
    if (bindingIdRepairApplied && classification.kind === 'history') {
      classification.permanent = true;
      classification.retryable = false;
      diagnose('repair_refused', { kind: classification.historyKind, source, status, refusal: 'repair_exhausted' });
      return null;
    }
    if (classification.kind === 'history' && classification.historyKind === 'account_reasoning_unavailable') {
      // Client-agnostic: both Claude and Codex Responses can receive this account message.
      // Remove prior encrypted reasoning once, then allow at most two retries in this request.
      const kind = classification.historyKind;
      diagnose('item_error', { kind, source, status, shape: summarizeResponsesBody(activeBody) });
      const stop = (reason, refusal = 'repair_exhausted') => {
        diagnose('repair_refused', { kind, source, status, refusal });
        log(`attempt ${attempt}: ${kind}: ${reason}; not retrying`);
        sendPermanent(res, `${kind}: the upstream account bound to this conversation is unavailable even after removing previous encrypted reasoning and retrying ${accountReasoningRetries} time(s).`);
        return 'stop';
      };
      if (policy.historyMode === 'off') return stop('history recovery is disabled by policy');
      if (preflightRefused) return stop('preflight history failed safety validation', 'unsafe_inline_history');
      if (!isResponses) return stop('automatic item repair is restricted to POST /v1/responses', 'wrong_endpoint');
      if (accountReasoningRetries >= 2) return stop('two retries exhausted');
      if (deadline - Date.now() < cfg.minRetryWindowMs + cfg.deployDelayMs) return stop('insufficient time budget', 'time_budget');
      if (accountReasoningRetries === 0) {
        const repaired = repairResponsesItems(activeBody, kind, eligibleCodex);
        if (repaired.error) return stop(repaired.error, 'unsafe_inline_history');
        activeBody = repaired.body;
        repairedItems = true;
        repairCount++;
        maxAttempts = Math.max(maxAttempts, attempt + 2);
        diagnose('repair_applied', { kind, source, status, removedIds: repaired.removedIds, removedReasoning: repaired.removedReasoning });
        log(`attempt ${attempt}: ${kind}: removed reasoning=${repaired.removedReasoning}; two retries remain`);
      } else {
        log(`attempt ${attempt}: ${kind}: retry ${accountReasoningRetries + 1}/2 with the same repaired request`);
      }
      accountReasoningRetries++;
      maxAttempts = Math.max(maxAttempts, attempt + 1);
      return 'retry';
    }
    if (classification.kind !== 'history' || (classification.missingSearchReasoning && !eligibleCodex)) return null;
    const kind = classification.historyKind;
    const azure = kind === 'azure_resource_mismatch';
    diagnose('item_error', { kind, source, status, shape: summarizeResponsesBody(activeBody) });
    // 两类历史错误都可能来自当前通道无法接续；无法安全改写不等于无法原样重试。
    if (eligibleCodex && ++resourceFailures >= 5) {
      diagnose('codex_resource_exhausted', { kind, source, status, resourceFailures, refusal: 'resource_attempt_limit' });
      log(`attempt ${attempt}: ${kind}; stopping after ${resourceFailures} resource attempts`);
      const refusalDetail = historyRepairRefusal ? ` history repair was refused: ${historyRepairRefusal}.` : '';
      sendPermanent(res, `${kind}: stopping after ${resourceFailures} resource attempts; upstream could not access the retained response history.${refusalDetail}`);
      return 'stop';
    }
    const fail = (reason, refusal = 'unsafe_inline_history') => {
      historyRepairRefusal = reason;
      diagnose('repair_refused', { kind, source, status, refusal });
      if (codexResourceRetry) {
        preserveResourceHistory = true;
        // Refusing a lossy rewrite does not rule out another route accepting the same history.
        lastReason = `${kind}: upstream could not access the retained response history`;
        if (ac.signal.aborted) return 'stop';
        if (attempt < maxAttempts && deadline - Date.now() >= cfg.minRetryWindowMs + cfg.deployDelayMs) {
          diagnose('codex_resource_retry', { kind, source, status, refusal });
          log(`attempt ${attempt}: ${kind}; retaining request history and retrying`);
          return 'retry';
        }
        diagnose('codex_resource_exhausted', { kind, source, status, refusal });
        sendRetryable(res, 503, lastReason, attempt, policy);
        return 'stop';
      }
      log(`attempt ${attempt}: ${kind}: repair refused: ${reason}; not retrying`);
      sendPermanent(res, `${kind}: ${reason}. Use the original Azure resource or resend complete inline history without server-side references; reasoning continuity cannot be preserved.`);
      return 'stop';
    };
    if (policy.historyMode === 'off') return fail('history recovery is disabled by policy');
    if (preflightRefused) return fail('preflight history failed safety validation');
    if (!isResponses) return fail('automatic item repair is restricted to POST /v1/responses', 'wrong_endpoint');
    // The default confirms on the first error. Custom thresholds accumulate only
    // this request's same-kind history evidence, never throttling or empty replies.
    if (eligibleCodex && historyRepairChecked) {
      lastReason = `${kind}: upstream could not access the retained response history`;
      if (ac.signal.aborted) return 'stop';
      if (attempt < maxAttempts && deadline - Date.now() >= cfg.minRetryWindowMs + cfg.deployDelayMs) {
        diagnose('codex_resource_retry', { kind, source, status, resourceFailures });
        return 'retry';
      }
      diagnose('codex_resource_exhausted', { kind, source, status, refusal: 'time_budget' });
      sendRetryable(res, 503, lastReason, attempt, policy);
      return 'stop';
    }
    if (repairedItems) return fail('single item-repair attempt exhausted', 'repair_exhausted');
    const confirmations = (historyErrorCounts.get(kind) || 0) + 1;
    historyErrorCounts.set(kind, confirmations);
    if (eligibleCodex && confirmations >= policy.historyConfirmations) historyRepairChecked = true;
    const repaired = repairResponsesItems(activeBody, kind, eligibleCodex);
    if (repaired.error) return fail(repaired.error);
    if (deadline - Date.now() < cfg.minRetryWindowMs + cfg.deployDelayMs) return fail('insufficient time budget for repair', 'time_budget');
    if (confirmations < policy.historyConfirmations) {
      if (ac.signal.aborted) return 'stop';
      if (attempt >= maxAttempts) return fail('history confirmation budget exhausted', 'time_budget');
      log(`attempt ${attempt}: ${kind}; confirmed ${confirmations}/${policy.historyConfirmations}, retaining history`);
      return 'retry';
    }
    if ((azure || eligibleCodex) && rememberCompatibility(compatibility, compatibilityCache)) {
      diagnose('session_compat_enabled', { kind, source: compatibility.source });
    }
    activeBody = repaired.body;
    repairedItems = true;
    if (eligibleCodex) { frozenHistoryKind = kind; historyRepairApplied = true; }
    repairCount++;
    diagnose('repair_applied', { kind, source, status, removedIds: repaired.removedIds, removedReasoning: repaired.removedReasoning });
    maxAttempts = Math.max(maxAttempts, attempt + (eligibleCodex ? 3 : 1));
    log(`attempt ${attempt}: ${kind}: removed item ids=${repaired.removedIds}, reasoning=${repaired.removedReasoning}; single repair retry (reasoning continuity may be lost)`);
    return 'retry';
  };

  // 通用组的空流/空 JSON 回复按可配置门槛分级处理：先整理 id/type，
  // 一级确实改动后才允许删除旧推理。明确限流和其他错误不累计到空回应门槛。
  let preCommitFailures = 0;
  let shapeRepairStage = 0;
  let shapeNormalized = false;   // 1 级是否确实改动过请求体（形状假设是否成立）
  const repairShape = (stage, attempt, source) => {
    const stripReasoning = stage === 2;
    const kind = stripReasoning ? 'empty_stream_reasoning' : 'empty_stream_shape';
    const repaired = repairResponsesItems(activeBody, kind);
    const changed = repaired.removedIds || repaired.removedTypes || repaired.removedReasoning;
    if (repaired.error || !changed) {
      diagnose('repair_refused', { kind, source, status: 200,
        refusal: repaired.error || 'nothing left to normalize' });
      return false;
    }
    activeBody = repaired.body;
    repairedItems = true;
    if (stage === 1) shapeNormalized = true;
    repairCount++;
    diagnose('repair_applied', { kind, source, status: 200, removedIds: repaired.removedIds,
      removedTypes: repaired.removedTypes, removedReasoning: repaired.removedReasoning });
    log(`attempt ${attempt}: pre-commit failure #${preCommitFailures} (${source}); `
      + (stripReasoning
        ? `removed reasoning items=${repaired.removedReasoning}; retrying without reasoning continuity`
        : `removed item ids=${repaired.removedIds}, message type tags=${repaired.removedTypes}; retrying with reasoning intact`));
    return true;
  };
  const notePreCommitFailure = (attempt, source) => {
    if (preserveResourceHistory && !eligibleCodex) return;
    preCommitFailures++;
    maxAttempts = Math.max(maxAttempts, cfg.deployMaxAttempts);
    // Codex history repair requires an explicit history error; empty replies alone
    // must neither trigger a lossy repair nor mutate the frozen/request-retained body.
    if (!isResponses || eligibleCodex || !policy.emptyResponseRepair) return;
    // 一级没有实际改动时不能升级；二级使用本组更高的空回应门槛。
    if (shapeRepairStage === 0 && !repairedItems && preCommitFailures >= policy.emptyResponseNormalizeAfter) {
      shapeRepairStage = 1;
      if (!repairShape(1, attempt, source)) return;
    }
    if (shapeRepairStage === 1 && shapeNormalized && policy.emptyResponseDropReasoning
        && preCommitFailures >= policy.emptyResponseReasoningAfter) {
      shapeRepairStage = 2;
      repairShape(2, attempt, source);
    }
  };

  const fallbackKind = 'uncovered_error_fallback';
  const canRetryFallback = (attempt, delayMs) => !ac.signal.aborted && !res.destroyed
    && attempt < maxAttempts && !fallbackSpent()
    && deadline - Date.now() >= cfg.minRetryWindowMs + delayMs;
  const finishFallbackFailure = (failure, refusal = 'repair_exhausted') => {
    fallback.phase = 'closed';
    diagnose('repair_refused', { kind: fallbackKind, source: failure.source, status: failure.status, refusal });
    observeRequest(state, 'result', 'error_passthrough');
    if (failure.source === 'sse_precommit') {
      const info = failure.classification.info;
      const error = { code: info?.code || 'upstream_error', type: info?.type || 'upstream_error',
        message: info?.message || failure.reason };
      passthrough(res, 502, new Headers({ 'content-type': 'application/json; charset=utf-8' }),
        Buffer.from(JSON.stringify({ error }), 'utf8'));
    } else {
      passthrough(res, failure.status, failure.headers, failure.buffer);
    }
    return 'stop';
  };
  const tryUncoveredFallback = async (failure, attempt) => {
    if (!fallbackEnabled || fallback.phase === 'closed' || repairedItems || repairedStatus || historyRepairChecked
        || resourceFailures || historyErrorCounts.size || shapeRepairStage || preflightRefused || preserveResourceHistory) {
      resetFallbackConfirmation();
      return null;
    }
    const delayMs = backoffMs(attempt, policy);
    if (!canRetryFallback(attempt, delayMs)) return finishFallbackFailure(failure, 'time_budget');
    if (fallback.phase === 'idle') {
      fallback.phase = 'confirming';
      await retrySleep(delayMs);
      return 'retry';
    }
    diagnose('item_error', { kind: fallbackKind, source: failure.source, status: failure.status,
      shape: summarizeResponsesBody(activeBody) });
    const repaired = repairResponsesItems(activeBody, fallbackKind, eligibleCodex);
    if (repaired.error) return finishFallbackFailure(failure, 'unsafe_inline_history');
    if (!canRetryFallback(attempt, delayMs)) return finishFallbackFailure(failure, 'time_budget');
    activeBody = repaired.body;
    repairedItems = true;
    repairCount++;
    fallback.phase = 'applied';
    fallback.remainingSends = Math.min(2, maxAttempts - attempt);
    diagnose('repair_applied', { kind: fallbackKind, source: failure.source, status: failure.status,
      removedIds: repaired.removedIds, removedReasoning: repaired.removedReasoning });
    await retrySleep(delayMs);
    return 'retry';
  };

  // Parse/commit stays with each carrier; recovery ordering and waits live here.
  // Unknown HTTP/JSON/SSE and final error envelopes deliberately remain distinct.
  const recoverFailure = async (failure, attempt) => {
    const { source, status, classification, headers, buffer } = failure;
    const info = classification.info;
    const ordinaryRate = !classification.permanent && !classification.deployment && (status === 429 || /^(rate_limit_error|rate_limit_exceeded|too_many_requests)$/i.test(info?.code || info?.type || '') || /\brate[ _-]?limit|too many requests/i.test(errorCauseText(info?.message)));
    if (ordinaryRate) {
      const hint = retryAfterMs(headers);
      const delay = Math.max(hint, backoffMs(attempt, policy));
      if (!state.retryRateLimit || attempt >= policy.maxAttempts || deadline - Date.now() < cfg.minRetryWindowMs + delay) {
        state.delegateRate = !state.retryRateLimit;
        const out = new Headers(headers);
        out.set('content-type', 'application/json');
        passthrough(res, 429, out, source === 'http_error' && buffer ? buffer : Buffer.from(JSON.stringify({error:info || {code:'rate_limit_exceeded',message:'Rate limited'}})));
        return 'stop';
      }
      if (fallback.phase !== 'applied' && !fallbackSpent()) {
        resetFallbackConfirmation();
        await retrySleep(delay);
        return 'retry';
      }
    }
    const isHttp = source === 'http_error';
    const isSse = source === 'sse_precommit';
    const retry = async (ms) => { await retrySleep(ms); return 'retry'; };
    observeRequest(state, 'failure', classification, headers);
    if (isSse) {
      lastReason = failure.reason;
      log(`attempt ${attempt}: ${lastReason}`);
      const fp = errorFingerprint(failure.errorMessage
        ? { code: failure.errorCode, message: failure.errorMessage } : null);
      diagnose('precommit_failure', { source, kind: failure.kind,
        code: fp ? fp.code : 'none', hints: fp ? fp.hints : '',
        masked: fp ? fp.masked : false, retryable: classification.retryable });
    }
    const uncovered = isUncoveredFallbackError(failure);
    if (!uncovered) resetFallbackConfirmation();
    if (fallback.phase === 'applied') {
      const hard = fallbackHardKind(classification.info, status);
      if (hard) {
        // Freeze the candidate: no later status/history/shape repair may change it.
        fallback.phase = 'closed';
        classification.permanent = true;
        classification.quota = hard === 'quota';
      } else {
        const delayMs = Math.max(backoffMs(attempt, policy), ordinaryRate ? retryAfterMs(headers) : 0);
        if (canRetryFallback(attempt, delayMs)) return retry(delayMs);
        return finishFallbackFailure(failure, fallbackSpent() ? 'repair_exhausted' : 'time_budget');
      }
    } else {
      const statusAction = handleStatusError(classification, attempt, source, status);
      if (statusAction === 'stop') return 'stop';
      if (statusAction === 'retry') return retry(cfg.deployDelayMs);
      const itemAction = handleItemError(classification, attempt, source, status);
      if (itemAction === 'stop') return 'stop';
      if (itemAction === 'retry') return retry(cfg.deployDelayMs);
      if (uncovered) {
        const action = await tryUncoveredFallback(failure, attempt);
        if (action) return action;
      }
    }
    // Repair refusal may mutate classification; inspect it only after both handlers.
    if (classification.permanent) {
      if (isHttp) {
        lastReason = `HTTP ${status} deterministic error: ${snippet(buffer)}`;
        log(`attempt ${attempt}: ${lastReason}`);
        log('  -> deterministic error, not retrying');
        observeRequest(state, 'result', 'permanent_error');
        passthrough(res, status, headers, buffer);
      } else {
        if (!isSse) {
          const info = classification.info;
          lastReason = `HTTP 200 but body was an error: ${info.code || info.type || ''} ${info.message}`;
          log(`attempt ${attempt}: ${lastReason}`);
        }
        log(classification.quota ? '  -> quota exhausted, not retrying'
          : '  -> permanent error, not retrying');
        observeRequest(state, 'result', 'permanent_error');
        sendPermanent(res, lastReason, classification.quota ? 402 : 400);
      }
      return 'stop';
    }
    if (isHttp && !classification.retryable) {
      observeRequest(state, 'result', 'error_passthrough');
      passthrough(res, status, headers, buffer);
      return 'stop';
    }
    if (!isHttp && !isSse && !classification.deployment && !classification.retryable) return 'pass';
    if (isHttp) lastReason = `HTTP ${status} ${snippet(buffer)}`;
    else if (!isSse) {
      const info = classification.info;
      lastReason = `HTTP 200 but body was an error: ${info.code || ''} ${info.message}`;
    }
    if (!isSse) log(`attempt ${attempt}: ${lastReason}`);
    if (classification.deployment) {
      maxAttempts = Math.max(maxAttempts, cfg.deployMaxAttempts);
      if (attempt < maxAttempts) {
        log('  -> deployment missing on this route, retrying for another route');
        return retry(cfg.deployDelayMs);
      }
      observeRequest(state, 'result', 'retry_exhausted');
      if (!isSse) {
        sendRetryable(res, 429, lastReason, attempt, policy);
        return 'stop';
      }
    }
    if (isSse && failure.kind === 'empty_stream_drop') {
      notePreCommitFailure(attempt, source);
      if (attempt < maxAttempts) return retry(cfg.deployDelayMs);
    }
    // Unknown SSE remains retryable; known rate errors never trigger history repair.
    if (attempt < maxAttempts) return retry(backoffMs(attempt, policy));
    observeRequest(state, 'result', 'retry_exhausted');
    sendRetryable(res, isHttp && status !== 429 ? 503 : 429, lastReason, attempt, policy);
    return 'stop';
  };

  for (let attempt = 1; attempt <= Math.min(maxAttempts, policy.maxAttempts); attempt++) {
    if (ac.signal.aborted || res.destroyed) return;
    if (fallbackSpent()) {
      diagnose('repair_refused', { kind: fallbackKind, refusal: 'repair_exhausted' });
      observeRequest(state, 'result', 'retry_exhausted');
      return sendRetryable(res, 503, lastReason, attemptCount, policy);
    }
    if (eligibleCodex && historyRepairApplied && postRepairSends >= 3) {
      diagnose('codex_resource_exhausted', { kind: frozenHistoryKind, resourceFailures,
        refusal: 'resource_attempt_limit' });
      return sendRetryable(res, 503, lastReason, attemptCount, policy);
    }
    // 剩余预算不足以支撑「再等一次 + 还可能再重试」时，就别开新尝试了：
    // 否则只会白等到客户端自己超时。
    const remaining = deadline - Date.now();
    if (attempt > 1 && remaining < cfg.minRetryWindowMs) {
      lastReason = `gave up retrying: only ${Math.round(remaining / 1000)}s of budget left`;
      log(`attempt ${attempt}: ${lastReason}`);
      observeRequest(state, 'result', 'retry_exhausted');
      return sendRetryable(res, 503, lastReason, attempt - 1, policy);
    }
    // 每次尝试独立控制器：既能被客户端断开连带中止，也能被超时单独中止
    const attemptAc = new AbortController();
    const onParentAbort = () => { if (!attemptAc.signal.aborted) attemptAc.abort(ac.signal.reason); };
    ac.signal.addEventListener('abort', onParentAbort, { once: true });
    let connectTimedOut = false;
    const waitMs = Math.max(1000, Math.min(attemptTimeoutMs, remaining));
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      if (!attemptAc.signal.aborted) attemptAc.abort(new Error('CONNECT_TIMEOUT'));
    }, waitMs);

    try {
      attemptCount = attempt;
      state.attempt = attempt;
      state.phase = 'waiting_headers';
      diagnose('attempt_started');
      let upstream;
      let buf;
      let ct;
      try {
        // 每条上游请求都用新连接。实测：网关自己重试 8 次、磨 110–180 秒全部失败，而 1–3 秒后
        // 客户端同样的新请求就能成功——1–3 秒不可能是限流窗口恢复的时间，说明重试沿用的那条
        // 上游连接被持续拒绝，换新连接即可通过。只给重试加还不够：首次尝试若保持 keep-alive，
        // 它的空闲连接会被下一次重试捡走（test/retry-fresh-connection.mjs 可复现），所以一律用
        // `connection: close`。代价是每条请求多一次握手（相对 20–40 秒的请求可忽略）。
        // `connection` 是逐跳头，站点看到的其它请求头与指纹没有任何变化。
        // Count actual fetch calls, even when no HTTP response arrives (network failure).
        if (ac.signal.aborted || res.destroyed) return;
        if (eligibleCodex && historyRepairApplied) postRepairSends++;
        if (fallback.phase === 'applied') fallback.remainingSends--;
        observeRequest(state, 'attempt');
        upstream = await state.fetch(target, {
          method: req.method,
          headers,
          body: noBody ? undefined : activeBody,
          redirect: 'error',
          signal: attemptAc.signal,
        });
        clearTimeout(connectTimer);
        state.phase = 'reading_body';
        diagnose('upstream_response', { status: upstream.status });
        ct = (upstream.headers.get('content-type') || '').toLowerCase();
        // 完整收包前的传输失败仍属于本次尝试；SSE 由独立交付与读取逻辑接管。
        if (!upstream.ok || !ct.includes('text/event-stream')) {
          buf = Buffer.from(await upstream.arrayBuffer());
        }
      } catch (e) {
        resetFallbackConfirmation();
        if (ac.signal.aborted || res.destroyed) return;
        if (outOfBudget()) {
          lastReason = `total budget ${policy.totalBudgetMs}ms exhausted`;
          log(`attempt ${attempt}: ${lastReason}`);
          observeRequest(state, 'result', 'retry_exhausted');
          return sendRetryable(res, 503, lastReason, attempt, policy);
        }
        lastReason = upstream ? `upstream response body read failed: ${describeFetchError(e)}`
          : connectTimedOut ? `upstream connect timeout after ${attemptTimeoutMs}ms`
          : `upstream connect failed: ${describeFetchError(e)}`;
        log(`attempt ${attempt}: ${lastReason}`);
        if (upstream && classifyError(null, upstream.status).permanent) {
          observeRequest(state, 'result', 'permanent_error');
          return sendRetryable(res, 502, lastReason, attempt, policy);
        }
        if (fallbackSpent()) {
          diagnose('repair_refused', { kind: fallbackKind, refusal: 'repair_exhausted' });
          observeRequest(state, 'result', 'retry_exhausted');
          return sendRetryable(res, 502, lastReason, attempt, policy);
        }
        // 连接或完整收包前的传输失败沿用通道重试机会。
        maxAttempts = Math.max(maxAttempts, cfg.deployMaxAttempts);
        if (attempt < maxAttempts) { await retrySleep(cfg.deployDelayMs); continue; }
        observeRequest(state, 'result', 'retry_exhausted');
        return sendRetryable(res, 502, lastReason, attempt, policy);
      } finally {
        clearTimeout(connectTimer);
      }

      if (!upstream.ok) {                       // 真实的 HTTP 错误
        const text = buf.toString('utf8');

        let errorInfo = null;
        try { errorInfo = errorInfoFromJson(JSON.parse(text)); }
        catch { errorInfo = { message: text.trim() }; }
        const action = await recoverFailure({ source: 'http_error', status: upstream.status,
          classification: classifyError(errorInfo, upstream.status), headers: upstream.headers, buffer: buf }, attempt);
        if (action === 'retry') continue;
        return;
      }

      if (ct.includes('text/event-stream')) {   // 流式
        state.phase = 'waiting_first_content';
        const outcome = await peekAndCommit(upstream, res, () => diagnose('sse_committed', { status: 200 }), state, clientCodex, bufferPrelude);
        if (outcome.committed) {
          observeRequest(state, 'terminal', outcome.terminalKind);
          observeRequest(state, 'result', outcome.terminalKind === 'response.completed' ? 'stream_completed' : 'stream_failed');
          diagnose('sse_ended', { status: 200, sawTerminal: outcome.sawTerminal, terminalKind: outcome.terminalKind, idleAfterCommit: outcome.idleAfterCommit, stallReason: outcome.stallReason });
          if (attempt > 1) log(`attempt ${attempt}: recovered on a later route (previous failures: ${attempt - 1})`);
          return;
        }
        if (ac.signal.aborted) return;
        const action = await recoverFailure({ ...outcome, source: 'sse_precommit',
          status: upstream.status, headers: upstream.headers }, attempt);
        if (action === 'retry') continue;
        return;
      }

      // 非流式
      let obj = null;
      try { obj = JSON.parse(buf.toString('utf8')); } catch { /* 非 JSON */ }

      const info = errorInfoFromJson(obj);
      if (info) {
        const action = await recoverFailure({ source: 'json_error', status: upstream.status,
          classification: classifyError(info), headers: upstream.headers, buffer: buf }, attempt);
        if (action === 'retry') continue;
        if (action === 'stop') return;
      }

      if (obj && isEmptyCompletion(obj)) {      // 空回应
        resetFallbackConfirmation();
        lastReason = 'empty response (HTTP 200 but message.content is blank)';
        log(`attempt ${attempt}: ${lastReason}`);
        if (fallback.phase === 'applied') {
          if (canRetryFallback(attempt, cfg.deployDelayMs)) {
            await retrySleep(cfg.deployDelayMs);
            continue;
          }
          diagnose('repair_refused', { kind: fallbackKind, source: 'json_empty', status: 200,
            refusal: fallbackSpent() ? 'repair_exhausted' : 'time_budget' });
          observeRequest(state, 'result', 'retry_exhausted');
          return sendRetryable(res, 502, lastReason, attempt, policy);
        }
        notePreCommitFailure(attempt, 'json_empty');
        if (attempt < maxAttempts) {
          log('  -> upstream closed the stream with no content, retrying for another route');
          await retrySleep(cfg.deployDelayMs);
          continue;
        }
        observeRequest(state, 'result', 'retry_exhausted');
        return sendRetryable(res, 429, lastReason, attempt, policy);
      }

      if (!info) {
        observeRequest(state, 'result', 'json_returned');
        if (obj) observeRequest(state, 'usage', obj);
      }
      if (attempt > 1) log(`attempt ${attempt}: recovered on a later route (previous failures: ${attempt - 1})`);
      return passthrough(res, 200, upstream.headers, buf);
    } finally {
      clearTimeout(connectTimer);
      ac.signal.removeEventListener('abort', onParentAbort);
    }
  }
  if (!ac.signal.aborted && !res.headersSent) sendRetryable(res, 503, lastReason, attemptCount, policy);
}

function retryAfterMs(headers) {
  const millis = headers?.get('retry-after-ms');
  if (millis && /^\d+$/.test(millis)) return Number(millis);
  const hint = headers?.get('retry-after');
  if (!hint) return 0;
  if (/^\d+(\.\d+)?$/.test(hint)) return Number(hint) * 1000;
  const date = Date.parse(hint);
  return Number.isFinite(date) ? Math.max(0,date-Date.now()) : 0;
}

function isKnownStreamEvent(event) {
  if (['response.created','response.in_progress','response.queued','response.completed','response.incomplete','response.failed','message_start','message_stop','message_delta','content_block_stop','ping'].includes(event.type)) return true;
  if (event.type === 'content_block_start') return ['text','thinking','redacted_thinking','tool_use','server_tool_use','web_search_tool_result'].includes(event.content_block?.type);
  if (event.type === 'content_block_delta') return ['text_delta','thinking_delta','input_json_delta','signature_delta'].includes(event.delta?.type);
  if (['response.output_item.added','response.output_item.done'].includes(event.type)) return ['message','reasoning','function_call','web_search_call'].includes(event.item?.type);
  return ['response.content_part.added','response.content_part.done','response.output_text.delta','response.output_text.done','response.refusal.delta','response.refusal.done','response.function_call_arguments.delta','response.function_call_arguments.done'].includes(event.type);
}

export const defaults = Object.freeze({
  upstream: 'https://agentrouter.org', maxAttempts: 110, baseDelayMs: 500, maxDelayMs: 1000,
  totalBudgetMs: 300000, connectTimeoutMs: 220000, connectTimeoutPerMbMs: 30000,
  minRetryWindowMs: 30000, deployMaxAttempts: 8, deployDelayMs: 800, peekIdleMs: 45000,
  peekTotalMs: 120000, streamIdleMs: 90000, streamProgressMs: 180000, sseBufferMaxBytes: 64*1024*1024,
  sessionCompat: true, sessionCompatTtlMs: 86400000, sessionCompatMaxKeys: 4096, extraRetryCodes: [],
});

export function profileFor(codex, overrides) {
  return { ...defaults, historyMode:'on_error', historyConfirmations:1, uncoveredErrorFallback:true,
    stripItemIds:codex, rememberSession:true, repairStatus:true, retryHistory:codex,
    emptyResponseRepair:!codex, emptyResponseDropReasoning:!codex, emptyResponseNormalizeAfter:2,
    emptyResponseReasoningAfter:6, ...overrides };
}

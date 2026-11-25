import { createHash } from 'node:crypto';
import { handle } from './relay-core.mjs';
import { defaults } from './settings.mjs';

const denial = status => Response.json({ error: { code:'relay_attempt_closed', message:'This request has no further upstream attempts.' } }, { status });

function consumeTag(bytes) {
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { return { bytes }; }
  if (!body || !Object.hasOwn(body, '_ag_relay_request')) return { bytes };
  const value = body._ag_relay_request;
  delete body._ag_relay_request;
  const tag = Array.isArray(value) && typeof value[0] === 'string' && /^[a-z0-9-]{8,80}$/.test(value[0]) && Number.isSafeInteger(value[1]) && value[1]>0 ? value : undefined;
  return { bytes:Buffer.from(JSON.stringify(body)), tag };
}

function drive(request, state, finish) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const controller = state.controller;
  let writer, status, headers, done = false;
  const settle = () => {
    if (done) return;
    done = true;
    request.signal.removeEventListener('abort', abort);
    finish(status || 502, state.delegateRate === true);
  };
  const abort = () => {
    controller.abort(request.signal.reason);
    if (writer) void writer.abort(controller.signal.reason).catch(() => {});
    reject(controller.signal.reason);
    settle();
  };
  const sink = {
    get headersSent() { return status !== undefined; },
    get destroyed() { return controller.signal.aborted; },
    writeHead(code, values) {
      status = code;
      headers = new Headers(values);
      headers.delete('content-length');
      if (/^text\/event-stream/i.test(headers.get('content-type') || '') && code === 200) {
        const stream = new TransformStream();
        writer = stream.writable.getWriter();
        writer.closed.catch(() => { if (!done) abort(); });
        resolve(new Response(stream.readable, { status, headers }));
      }
    },
    write(chunk) { return writer.write(chunk); },
    end(data) {
      if (writer) void writer.close().catch(() => {});
      else resolve(new Response([204,205,304].includes(status) ? null : data, { status, headers }));
      settle();
    },
  };
  request.signal.addEventListener('abort',abort,{once:true});
  if (request.signal.aborted) abort();
  else handle(request,sink,state).catch(error => {
    reject(error);
    if (writer) void writer.abort(error).catch(() => {});
    settle();
  });
  return promise;
}

export function createTransport(fetchUpstream = fetch, overrides = {}) {
  const turns = new Map();
  const cap = overrides.maxAttempts ?? defaults.maxAttempts;
  const budget = overrides.totalBudgetMs ?? defaults.totalBudgetMs;
  return async function send(request, context) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return fetchUpstream(request);
    const { bytes, tag } = consumeTag(Buffer.from(await request.arrayBuffer()));
    request.signal.throwIfAborted();
    const now = Date.now();
    for (const [key, turn] of turns) if (!turn.active && turn.expires <= now) turns.delete(key);
    const key = tag && createHash('sha256').update(JSON.stringify([request.headers.get('authorization'),tag[0]])).digest('hex');
    let turn = key && turns.get(key);
    if (turn && (turn.active || !turn.delegate || turn.used >= cap || now >= turn.deadline)) return denial(turn.status || 429);
    if (!turn && tag && (tag[1] !== 1 || turns.size >= 8192)) return denial(503);
    if (!turn) {
      turn = { active:false, used:0, deadline:now+budget, expires:now+budget+600000, status:429 };
      if (key) turns.set(key,turn);
    }
    turn.active = true;
    const controller = new AbortController();
    const state = { ...context, path, controller, started:now, body:bytes, bytesReceived:0, eventCount:0, reasoningEvents:0,textEvents:0,toolEvents:0,
      policy:{ ...overrides, maxAttempts:tag ? cap-turn.used : 1, totalBudgetMs:turn.deadline-now },
      fetch:(...args) => { turn.used++; return fetchUpstream(...args); } };
    return drive(request,state,(status,delegate) => {
      turn.active = false;
      turn.status = status >= 400 && status < 600 ? status : 409;
      turn.delegate = delegate && !controller.signal.aborted;
      turn.expires = Date.now()+600000;
    });
  };
}

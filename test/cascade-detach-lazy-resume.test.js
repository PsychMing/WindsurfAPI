// Detach P1 — end-to-end lazy resume (T1–T19).
//
// Harness: a scripted loopback LS (the shape used by
// test/cascade-abort-side-effects.test.js) plus a response double that closes
// the socket at a chosen write. The producer is the real cascadeChat; the
// handler is the real streamResponse.
//
// What P1 promises and these tests pin:
//   - an aborted mid-stream turn freezes a v2 snapshot (T1);
//   - a byte-identical retry CLAIMS it and continues the original poll loop:
//     no StartCascade, no SendUserCascadeMessage, prefix replayed exactly once
//     (T5, T7, T11);
//   - billing starts the metadata RPC at the snapshot's generatorOffset (T3)
//     and lands on the entry's owner account even though the resume has no
//     checked-out account (T5);
//   - every negative (pre-content, tool call, tenant, shutdown, drain, TTL,
//     generation, cascade gone, account removed) admits nothing and falls
//     back to upstream, each with a positive control in the same file.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { endOfStreamEnvelope, unwrapRequest, wrapEnvelope } from '../src/connect.js';
import { getField, parseFields, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';

// Module-level env (client.js snapshots CASCADE_TIMEOUTS, grpc.js snapshots
// GRPC_PROTOCOL). Both switches are on for this file; the flag-off parity test
// deletes the detach switch around its request.
process.env.GRPC_PROTOCOL = 'connect';
process.env.CASCADE_POLL_INTERVAL_MS = '5';
process.env.CASCADE_IDLE_GRACE_MS = '1';
process.env.CASCADE_MAX_WAIT_MS = '3000';
process.env.CASCADE_COLD_STALL_BASE_MS = '3000';
process.env.CASCADE_WARM_STALL_MS = '3000';
process.env.RESPONSE_CACHE_ENABLED = '0';
process.env.WINDSURFAPI_CASCADE_TURN = '1';
process.env.WINDSURFAPI_CASCADE_DETACH = '1';

const PREFIX = 'PREFIX-ANSWER-';
const GROWTH = 'GROWTH-AFTER-DETACH-';
const FULL_TEXT = `${PREFIX}${GROWTH}`;

let WindsurfClient;
let handleChatCompletions;
let resolveModel;
let auth;
let cache;
let pool;
let registry;
let sse;

// ── proto helpers ────────────────────────────────────────────
function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

function responseBody(payload, headers) {
  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('application/connect+proto')) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function endOfStreamError(message, code = 'not_found') {
  const trailer = Buffer.from(JSON.stringify({ error: { code, message } }));
  const frame = Buffer.alloc(5 + trailer.length);
  frame[0] = 0x02;
  frame.writeUInt32BE(trailer.length, 1);
  trailer.copy(frame, 5);
  return frame;
}

function plannerStep(text, { status = 3, thinking = '', toolCall = null } = {}) {
  const plannerParts = [writeStringField(1, text)];
  if (thinking) plannerParts.push(writeStringField(3, thinking));
  const parts = [
    writeVarintField(1, 15), // CORTEX_STEP_TYPE_PLANNER_RESPONSE
    writeVarintField(4, status),
    writeMessageField(20, Buffer.concat(plannerParts)),
  ];
  if (toolCall) {
    const call = Buffer.concat([
      writeStringField(1, toolCall.id),
      writeStringField(2, toolCall.name),
      writeStringField(3, toolCall.argumentsJson),
    ]);
    // 49 = tool_call_proposal { 1 = ChatToolCall }
    parts.push(writeMessageField(49, writeMessageField(1, call)));
  }
  return Buffer.concat(parts);
}

function rawStepsResponse(steps) {
  return Buffer.concat(steps.map(step => writeMessageField(1, step)));
}

function readStepOffset(payload) {
  const field = getField(parseFields(payload), 2, 0);
  return field ? Number(field.value) : 0;
}

function metadataEntry(inputTokens, outputTokens) {
  const usage = Buffer.concat([
    writeVarintField(2, inputTokens),
    writeVarintField(3, outputTokens),
  ]);
  const chatModel = writeMessageField(4, usage);
  return writeMessageField(1, chatModel); // CortexStepGeneratorMetadata.chat_model
}

function metadataResponse(records) {
  return Buffer.concat(records.map(record => writeMessageField(1, record)));
}

// ── scripted upstream ────────────────────────────────────────
/**
 * One fake LS per test. `state.grown` flips the same step from PREFIX to
 * FULL_TEXT (in-place growth, the E2b shape). `state.status` is ACTIVE until
 * the test flips it to IDLE. `state.failNextSteps` makes the next steps read
 * a Connect end-stream error (cascade gone).
 */
function cascadeUpstream({ initialText = PREFIX, toolCall = null, thinkingOnly = false } = {}) {
  const state = {
    startCalls: 0,
    sendCalls: 0,
    stepsCalls: 0,
    statusCalls: 0,
    metadataCalls: 0,
    metadataOffsets: [],
    stepsOffsets: [],
    grown: false,
    status: 'active',
    failNextSteps: 0,
    resumeDelayMs: 0,
    firstResumeRead: true,
    stepsFor: null, // optional (offset) => Buffer
  };
  const handler = (stream, headers) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const method = String(headers[':path'] || '').split('/').pop();
      const contentType = headers['content-type'] || 'application/grpc';
      const payload = unwrapRequest(Buffer.concat(chunks), headers);
      const respond = (body) => {
        stream.respond({ ':status': 200, 'content-type': contentType });
        stream.end(responseBody(body, headers));
      };

      if (method === 'StartCascade') {
        state.startCalls += 1;
        respond(writeStringField(1, 'detach-cascade'));
        return;
      }
      if (method === 'SendUserCascadeMessage') {
        state.sendCalls += 1;
        respond(Buffer.alloc(0));
        return;
      }
      if (method === 'GetCascadeTrajectorySteps') {
        state.stepsCalls += 1;
        const offset = readStepOffset(payload);
        state.stepsOffsets.push(offset);
        if (state.failNextSteps > 0) {
          state.failNextSteps -= 1;
          stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
          stream.end(endOfStreamError('cascade not found'));
          return;
        }
        const delay = state.grown && state.firstResumeRead ? state.resumeDelayMs : 0;
        state.firstResumeRead = false;
        const bodyFor = () => {
          if (state.stepsFor) return state.stepsFor(offset);
          const text = state.grown ? (thinkingOnly ? '' : FULL_TEXT) : initialText;
          const step = plannerStep(text, {
            status: state.grown ? 3 : 1,
            thinking: thinkingOnly ? (state.grown ? `${PREFIX}${GROWTH}` : PREFIX) : '',
            toolCall: state.grown ? null : toolCall,
          });
          return rawStepsResponse(offset === 0 ? [step] : []);
        };
        if (delay > 0) {
          setTimeout(() => respond(bodyFor()), delay);
        } else {
          respond(bodyFor());
        }
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        state.statusCalls += 1;
        respond(writeVarintField(2, state.status === 'idle' ? 1 : 2));
        return;
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        state.metadataCalls += 1;
        const offset = readStepOffset(payload);
        state.metadataOffsets.push(offset);
        // Offset 0 reports THREE records (the whole cascade history); offset 7
        // reports ONE (the current turn only). A resume that forgets the
        // snapshot offset over-bills by the difference.
        respond(metadataResponse(offset === 0
          ? [metadataEntry(100, 10), metadataEntry(100, 10), metadataEntry(100, 10)]
          : [metadataEntry(100, 10)]));
        return;
      }
      respond(Buffer.alloc(0));
    });
  };
  return { state, handler };
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise(resolve => server.close(resolve));
  }
}

// ── response doubles ────────────────────────────────────────
/**
 * A response with Node's destroyed-peer facts: `close` fires, writableEnded
 * stays false, writes after close are accepted silently. `closeAfterWrites`
 * fires the close AFTER the Nth write is recorded.
 */
function makeResponse({ closeAfterWrites = 0, backpressure = false } = {}) {
  const listeners = new Map();
  const writes = [];
  const state = { closed: false, writableEnded: false, statusCode: 0, body: '' };
  const res = {
    statusCode: 0,
    get writableEnded() { return state.writableEnded; },
    writeHead(status) { state.statusCode = status; res.statusCode = status; },
    write(chunk) {
      const text = String(chunk);
      state.body += text;
      writes.push({ text, afterClose: state.closed });
      if (backpressure && text.includes('"content":"')) return false;
      if (closeAfterWrites && writes.length >= closeAfterWrites && !state.closed) {
        res.emit('close');
      }
      return true;
    },
    end(chunk) {
      if (chunk) res.write(chunk);
      state.writableEnded = true;
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    once(event, cb) {
      const wrap = (...args) => { res.removeListener(event, wrap); cb(...args); };
      res.on(event, wrap);
    },
    removeListener(event, cb) {
      const list = listeners.get(event) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(event, ...args) {
      if (event === 'close') state.closed = true;
      for (const cb of [...(listeners.get(event) || [])]) cb(...args);
    },
  };
  return { res, writes, state };
}

// ── handler context + accounts ──────────────────────────────
function seedAccount(label) {
  const a = auth.addAccountByKey(`devin-session-token$xk-detach-${label}-${Math.random().toString(36).slice(2)}`, label);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

function makeLsFake(port) {
  return {
    port,
    csrfToken: 'csrf',
    generation: 1,
    activeRequests: 0,
    maxActive: 0,
    beginCalls: 0,
    endCalls: 0,
    acquireCalls: 0,
  };
}

function handlerContext(port, acct, lsFake, overrides = {}) {
  return {
    callerKey: 'session:detach-lazy-resume',
    waitForAccount: (tried, _signal, _maxWait, modelKey) => (acct
      ? { id: acct.id, email: acct.email, apiKey: acct.apiKey, proxy: null }
      : auth.getApiKey(tried, modelKey)),
    ensureLs: async () => {},
    getLsFor: () => ({ port, csrfToken: 'csrf', generation: lsFake ? lsFake.generation : 1 }),
    getLsEntryByPort: (p) => (lsFake && p === port ? lsFake : null),
    beginLsUse: (p) => {
      if (!lsFake || p !== port) return null;
      lsFake.beginCalls += 1;
      lsFake.activeRequests += 1;
      lsFake.maxActive = Math.max(lsFake.maxActive, lsFake.activeRequests);
      return lsFake;
    },
    endLsUse: (p) => {
      if (!lsFake || p !== port) return;
      lsFake.endCalls += 1;
      lsFake.activeRequests = Math.max(0, lsFake.activeRequests - 1);
    },
    acquireLsUse: (p) => {
      if (!lsFake || p !== port) return null;
      lsFake.acquireCalls += 1;
      if (lsFake.activeRequests > 0) throw new Error('resume acquired a second LS lease');
      lsFake.activeRequests += 1;
      lsFake.maxActive = Math.max(lsFake.maxActive, lsFake.activeRequests);
      return lsFake;
    },
    WindsurfClient,
    ...overrides,
  };
}

function bodyFor(marker) {
  return {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: `detach test ${marker}` }],
    stream: true,
  };
}

const createdIds = [];

before(async () => {
  ({ WindsurfClient } = await import('../src/client.js'));
  ({ handleChatCompletions } = await import('../src/handlers/chat.js'));
  ({ resolveModel } = await import('../src/models.js'));
  auth = await import('../src/auth.js');
  cache = await import('../src/cache.js');
  pool = await import('../src/conversation-pool.js');
  registry = await import('../src/detached-registry.js');
  sse = await import('../src/sse-registry.js');
});

beforeEach(() => {
  cache.cacheClear();
  pool.poolClear();
  registry.detachedRegistry.reset();
});

after(() => {
  registry.detachedRegistry.reset();
  while (createdIds.length) {
    try { auth.removeAccount(createdIds.pop()); } catch {}
  }
  cache.cacheClear();
  pool.poolClear();
});

// ── drivers ─────────────────────────────────────────────────
async function startStream(body, ctx) {
  const result = await handleChatCompletions(body, ctx);
  assert.equal(result.status, 200, `expected a stream, got ${JSON.stringify(result.body || result)}`);
  assert.equal(result.stream, true);
  return result;
}

async function runToCompletion(body, ctx, responseOpts) {
  const result = await startStream(body, ctx);
  const { res, writes, state } = makeResponse(responseOpts);
  await result.handler(res);
  return { res, writes, state };
}

function detachKeyOf(body, callerKey = 'session:detach-lazy-resume') {
  return registry.detachedKey(body, callerKey, {
    scopeTrusted: true,
    route: 'chat',
    modelKey: resolveModel(body.model),
    toolPreambleTier: null,
    emulateTools: false,
    native: null,
    stop: [],
    displayModel: body.model,
  });
}

function contentOf(state) {
  return state.body
    .split('\n\n')
    .filter(frame => frame.startsWith('data: '))
    .map(frame => {
      try { return JSON.parse(frame.slice(6)); } catch { return null; }
    })
    .filter(Boolean)
    .map(data => data.choices?.[0]?.delta?.content || '')
    .join('');
}

function spendOf(acct) {
  return auth.getAccountPublic(acct.id)?.totalSpend?.totalTokens ?? 0;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return false;
}

// ── T1/T2/T4/T10/T19: admission gates ───────────────────────
describe('Detach P1 admission gates', () => {
  it('T1 an aborted mid-stream turn admits one resumable snapshot', async () => {
    const acct = seedAccount('t1');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t1');
      const ctx = handlerContext(port, acct, lsFake);
      const { state: resState } = await runToCompletion(body, ctx, { closeAfterWrites: 2 });

      assert.equal(resState.closed, true, 'precondition: the client closed mid-stream');
      assert.ok(resState.body.includes(PREFIX), 'precondition: the prefix reached the client');
      assert.equal(registry.detachedRegistry.stats().admit, 1);
      assert.equal(registry.detachedRegistry.stats().refuse.not_client_gone, 0);
      const entry = registry.detachedRegistry.lookup(detachKeyOf(body), 'session:detach-lazy-resume');
      assert.ok(entry, 'the snapshot must be admitted');
      assert.equal(entry.snapshot.version, 2);
      assert.equal(entry.snapshot.consumedThrough, entry.snapshot.stepOffset);
      assert.equal(entry.pin.accountId, acct.id);
      assert.equal(entry.pin.lsGeneration, 1);
      // No lease is pinned beyond the request.
      assert.equal(lsFake.activeRequests, 0, 'a detached entry must not hold beginLsUse');
      assert.equal(state.startCalls, 1);
    });
  });

  it('T2 a pre-content abort admits nothing and the retry reaches upstream', async () => {
    const acct = seedAccount('t2');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t2');
      const ctx = handlerContext(port, acct, lsFake);
      // No producer chunk has arrived yet: the trajectory is still warming,
      // so the response is closed externally. Nothing may be admitted.
      state.stepsFor = () => rawStepsResponse([]);
      const result = await startStream(body, ctx);
      const { res } = makeResponse({});
      const run = result.handler(res);
      await new Promise(resolve => setTimeout(resolve, 25));
      res.emit('close');
      await run;
      assert.equal(registry.detachedRegistry.stats().admit, 0);
      assert.equal(registry.detachedRegistry.stats().refuse.not_client_gone, 0);

      state.stepsFor = null;
      state.status = 'idle';
      state.grown = true;
      await runToCompletion(body, ctx, {});
      assert.equal(state.startCalls, 2, 'a retry with no entry must reach upstream');
    });
  });

  it('T4 a tool-call turn admits nothing and the retry reaches upstream', async () => {
    const acct = seedAccount('t4');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream({
      toolCall: { id: 'call-1', name: 'view_file', argumentsJson: '{"path":"a"}' },
    });
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t4');
      const ctx = handlerContext(port, acct, lsFake);
      await runToCompletion(body, ctx, { closeAfterWrites: 2 });
      assert.equal(registry.detachedRegistry.stats().admit, 0, 'P1 must not admit a tool turn');

      state.status = 'idle';
      state.grown = true;
      await runToCompletion(body, ctx, {});
      assert.equal(state.startCalls, 2);
    });
  });

  it('T10 a normal stream end admits nothing', async () => {
    const acct = seedAccount('t10');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t10');
      state.status = 'idle';
      const { state: resState } = await runToCompletion(body, handlerContext(port, acct, lsFake), {});
      assert.equal(resState.writableEnded, true);
      assert.equal(registry.detachedRegistry.stats().admit, 0);
      assert.equal(registry.detachedRegistry.stats().entries, 0);
    });
  });

  it('T19 an idle-empty turn is not stored as complete', async () => {
    const acct = seedAccount('t19');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream({ thinkingOnly: true });
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      state.status = 'idle';
      await runToCompletion(bodyFor('t19'), handlerContext(port, acct, lsFake), {});
      assert.equal(registry.detachedRegistry.stats().admit, 0);
      assert.equal(registry.detachedRegistry.stats().entries, 0);
    });
  });

  it('flag-off parity: with WINDSURFAPI_CASCADE_DETACH unset nothing is admitted', async () => {
    const acct = seedAccount('off');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('off');
      const ctx = handlerContext(port, acct, lsFake);
      delete process.env.WINDSURFAPI_CASCADE_DETACH;
      try {
        await runToCompletion(body, ctx, { closeAfterWrites: 2 });
        assert.equal(registry.detachedRegistry.stats().admit, 0);
        state.status = 'idle';
        state.grown = true;
        await runToCompletion(body, ctx, {});
        assert.equal(state.startCalls, 2, 'flag off keeps the pre-existing retry-to-upstream contract');
      } finally {
        process.env.WINDSURFAPI_CASCADE_DETACH = '1';
      }
    });
  });
});

// ── T5/T7/T11: the resume ───────────────────────────────────
describe('Detach P1 lazy resume', () => {
  it('T5/T7 an identical retry is served from the entry, prefix exactly once, billed to the owner', async () => {
    const owner = seedAccount('t5-owner');
    const other = seedAccount('t5-other');
    createdIds.push(owner.id, other.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t5');
      const ownerCtx = handlerContext(port, owner, lsFake);
      await runToCompletion(body, ownerCtx, { closeAfterWrites: 2 });
      assert.equal(registry.detachedRegistry.stats().admit, 1);
      assert.equal(spendOf(owner), 0, 'the aborted original is not billed');

      state.status = 'idle';
      state.grown = true;
      const ownerSpendBefore = spendOf(owner);
      const otherSpendBefore = spendOf(other);
      // The retry may be routed to a different account; the resume must not
      // check it out, and must bill the entry owner instead.
      const retryCtx = handlerContext(port, other, lsFake);
      const { state: resState } = await runToCompletion(body, retryCtx, {});

      assert.equal(state.startCalls, 1, 'a resume must not StartCascade again');
      assert.equal(state.sendCalls, 1, 'a resume must not SendUserCascadeMessage again');
      assert.equal(contentOf(resState), FULL_TEXT, 'the answer is the full text, prefix + growth');
      assert.equal(resState.body.split(PREFIX).length - 1, 1, 'the prefix is replayed exactly once');

      const ownerDelta = spendOf(owner) - ownerSpendBefore;
      const otherDelta = spendOf(other) - otherSpendBefore;
      assert.equal(ownerDelta, 330, `billing must land on the owner (got ${ownerDelta})`);
      assert.equal(otherDelta, 0, `the retry account must not be billed (got ${otherDelta})`);
      assert.equal(registry.detachedRegistry.stats().serve, 1);
      assert.equal(registry.detachedRegistry.stats().billed_detached, 1);
      assert.equal(registry.detachedRegistry.stats().entries, 0, 'served entries are deleted');
      assert.equal(lsFake.maxActive, 1, 'exactly one request lease during the resume');
      assert.equal(lsFake.activeRequests, 0, 'the lease is released when the request ends');
      assert.equal(lsFake.acquireCalls, 0, 'leaseHeld must prevent a second acquire');
    });
  });

  it('T3 the metadata RPC starts at the snapshot generatorOffset (no over-bill)', async () => {
    const owner = seedAccount('t3-owner');
    createdIds.push(owner.id);
    const { state, handler } = cascadeUpstream();
    // A resumed pool turn starts at absolute offsets 7/7. The snapshot must
    // carry generatorOffset 7 so the retry's metadata RPC asks for the LAST
    // turn only (1 record), not the whole cascade (3 records).
    state.stepsFor = (offset) => {
      if (offset !== 7) return rawStepsResponse([]);
      return rawStepsResponse([plannerStep(state.grown ? FULL_TEXT : PREFIX, { status: state.grown ? 3 : 1 })]);
    };
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'detach test t3' },
        ],
        stream: true,
      };
      const ctx = handlerContext(port, owner, lsFake);
      const modelKey = resolveModel(body.model);
      const fpBefore = pool.fingerprintBefore(body.messages, modelKey, ctx.callerKey, {
        tools: [], toolChoice: null, toolPreamble: '', preambleTier: null,
        emulateTools: false, route: 'chat',
      });
      pool.checkin(fpBefore, {
        cascadeId: 'seeded-detach-t3',
        sessionId: 'seeded-session',
        lsPort: port,
        lsGeneration: 1,
        apiKey: owner.apiKey,
        modelKey,
        stepOffset: 7,
        generatorOffset: 7,
      }, ctx.callerKey, 0);
      await runToCompletion(body, ctx, { closeAfterWrites: 2 });
      assert.equal(state.startCalls, 0, 'precondition: the original request resumed the seeded cascade');
      assert.equal(registry.detachedRegistry.stats().admit, 1);
      const entry = registry.detachedRegistry.lookup(detachKeyOf(body), ctx.callerKey);
      assert.equal(entry.snapshot.generatorOffset, 7);
      assert.equal(entry.snapshot.stepOffset, 8);

      state.status = 'idle';
      state.grown = true;
      state.metadataOffsets.length = 0;
      const spendBefore = spendOf(owner);
      await runToCompletion(body, ctx, {});

      assert.deepEqual(state.metadataOffsets, [7],
        `the resume asked metadata from offset(s) ${state.metadataOffsets.join(',')} — 0 re-sums the cascade`);
      assert.equal(spendOf(owner) - spendBefore, 110,
        'the resumed turn must bill only its own record, not all three');
    });
  });

  it('T11 a detached entry pins no LS lease; the resume holds exactly one', async () => {
    const acct = seedAccount('t11');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t11');
      const ctx = handlerContext(port, acct, lsFake);
      await runToCompletion(body, ctx, { closeAfterWrites: 2 });
      assert.equal(lsFake.activeRequests, 0, 'the detached entry must not keep a beginLsUse pin');

      state.status = 'idle';
      state.grown = true;
      const { state: resState } = await runToCompletion(body, ctx, {});
      assert.equal(lsFake.maxActive, 1, `activeRequests peaked at ${lsFake.maxActive}; a double acquire shows 2`);
      assert.equal(lsFake.activeRequests, 0);
      assert.equal(lsFake.acquireCalls, 0);
      assert.ok(contentOf(resState).includes(GROWTH));
    });
  });
});

// ── T6/T12/T13/T15/T16/T17: negative + positive control ─────
describe('Detach P1 fallbacks', () => {
  it('T6 a different caller scope never sees the entry', async () => {
    const acct = seedAccount('t6');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t6');
      await runToCompletion(body, handlerContext(port, acct, lsFake), { closeAfterWrites: 2 });
      assert.equal(registry.detachedRegistry.stats().admit, 1);

      state.status = 'idle';
      state.grown = true;
      const otherCtx = { ...handlerContext(port, acct, lsFake), callerKey: 'session:someone-else' };
      const { state: resState } = await runToCompletion(body, otherCtx, {});
      assert.equal(state.startCalls, 2, 'a cross-tenant retry must reach upstream');
      assert.equal(contentOf(resState), FULL_TEXT);
      assert.ok(registry.detachedRegistry.stats().lookup.miss >= 1);
    });
  });

  it('T12 an LS generation change evicts the entry and falls back upstream', async () => {
    const acct = seedAccount('t12');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t12');
      const ctx = handlerContext(port, acct, lsFake);
      await runToCompletion(body, ctx, { closeAfterWrites: 2 });
      assert.equal(registry.detachedRegistry.stats().admit, 1);

      lsFake.generation = 2; // LS restarted while detached
      state.status = 'idle';
      state.grown = true;
      await runToCompletion(body, ctx, {});
      assert.equal(state.startCalls, 2);
      assert.equal(registry.detachedRegistry.stats().evict.resume_miss, 1);
      assert.equal(registry.detachedRegistry.stats().entries, 0);
      assert.equal(lsFake.activeRequests, 0);
    });
  });

  it('T13 a dead cascade writes zero bytes before falling back upstream', async () => {
    const acct = seedAccount('t13');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t13');
      const ctx = handlerContext(port, acct, lsFake);
      await runToCompletion(body, ctx, { closeAfterWrites: 2 });

      state.failNextSteps = 1; // the resume's first read is not_found
      state.status = 'idle';
      state.grown = true;
      const { state: resState } = await runToCompletion(body, ctx, {});
      assert.equal(state.startCalls, 2, 'the fallback starts a fresh cascade');
      assert.equal(registry.detachedRegistry.stats().evict.resume_miss, 1);
      assert.equal(registry.detachedRegistry.stats().serve, 0);
      // The failed resume wrote nothing; the fresh turn wrote the answer once.
      assert.equal(resState.body.split(PREFIX).length - 1, 1);
      assert.equal(contentOf(resState), FULL_TEXT);
    });
  });

  it('T15 an expired entry is gone and the retry reaches upstream', async () => {
    const acct = seedAccount('t15');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t15');
      const ctx = handlerContext(port, acct, lsFake);
      registry.detachedRegistry.ttlMs = 5;
      try {
        await runToCompletion(body, ctx, { closeAfterWrites: 2 });
        assert.equal(registry.detachedRegistry.stats().admit, 1);
        await new Promise(resolve => setTimeout(resolve, 15));
        registry.detachedRegistry.sweepExpired();
        assert.equal(registry.detachedRegistry.stats().entries, 0);
        assert.equal(registry.detachedRegistry.stats().evict.ttl, 1);
        assert.equal(lsFake.activeRequests, 0, 'expiry releases nothing because no lease was pinned');

        state.status = 'idle';
        state.grown = true;
        await runToCompletion(body, ctx, {});
        assert.equal(state.startCalls, 2);
      } finally {
        registry.detachedRegistry.ttlMs = 120_000;
      }
    });
  });

  it('T16 the per-caller cap evicts the oldest running entry; the evicted retry goes upstream', async () => {
    const acct = seedAccount('t16');
    createdIds.push(acct.id);
    const first = cascadeUpstream();
    const second = cascadeUpstream();
    await withFakeLanguageServer(first.handler, async (port) => {
      // One fake server can serve both turns; swap the handler per phase.
      const lsFake = makeLsFake(port);
      const ctx = handlerContext(port, acct, lsFake);
      const bodyA = bodyFor('t16-a');
      const bodyB = bodyFor('t16-b');
      registry.detachedRegistry.maxPerCaller = 1;
      try {
        await runToCompletion(bodyA, ctx, { closeAfterWrites: 2 });
        assert.equal(registry.detachedRegistry.stats().admit, 1);
        await runToCompletion(bodyB, ctx, { closeAfterWrites: 2 });
        assert.equal(registry.detachedRegistry.stats().admit, 2);
        assert.equal(registry.detachedRegistry.stats().evict.capacity, 1);
        assert.equal(registry.detachedRegistry.lookup(detachKeyOf(bodyA), ctx.callerKey), null);

        first.state.status = 'idle';
        first.state.grown = true;
        const startBefore = first.state.startCalls;
        await runToCompletion(bodyA, ctx, {});
        assert.equal(first.state.startCalls, startBefore + 1, 'the evicted turn goes upstream');
      } finally {
        registry.detachedRegistry.maxPerCaller = 2;
      }
      void second;
    });
  });

  it('T17 removing the owner account evicts the entry and releases nothing else', async () => {
    const owner = seedAccount('t17-owner');
    const other = seedAccount('t17-other');
    createdIds.push(owner.id, other.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t17');
      await runToCompletion(body, handlerContext(port, owner, lsFake), { closeAfterWrites: 2 });
      assert.equal(registry.detachedRegistry.stats().admit, 1);

      auth.removeAccount(owner.id);
      // removeAccount evicts through a dynamic import.
      assert.ok(await waitFor(() => registry.detachedRegistry.stats().entries === 0), 'the entry must be evicted');
      assert.equal(registry.detachedRegistry.stats().evict.account_removed, 1);
      assert.equal(lsFake.activeRequests, 0);

      state.status = 'idle';
      state.grown = true;
      await runToCompletion(body, handlerContext(port, other, lsFake), {});
      assert.equal(state.startCalls, 2);
    });
  });
});

// ── T8/T9: shutdown and drain ───────────────────────────────
describe('Detach P1 server-side causes', () => {
  it('T8 a server shutdown admits nothing', async () => {
    const acct = seedAccount('t8');
    createdIds.push(acct.id);
    const { handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t8');
      const result = await startStream(body, handlerContext(port, acct, lsFake));
      const { res, state } = makeResponse({});
      const run = result.handler(res);
      assert.ok(await waitFor(() => state.body.includes(PREFIX)), 'precondition: the turn streamed');
      const aborted = sse.abortActiveSse('server shutting down');
      assert.ok(aborted >= 1);
      await run;
      assert.equal(registry.detachedRegistry.stats().admit, 0);
      assert.ok(registry.detachedRegistry.stats().refuse.not_client_gone >= 1);
      assert.equal(registry.detachedRegistry.stats().entries, 0);
      assert.equal(lsFake.activeRequests, 0);
    });
  });

  it('T9 a drain timeout admits nothing', async () => {
    const acct = seedAccount('t9');
    createdIds.push(acct.id);
    const { handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t9');
      process.env.WINDSURFAPI_MAX_DRAIN_MS = '1';
      try {
        await runToCompletion(body, handlerContext(port, acct, lsFake), { backpressure: true });
      } finally {
        delete process.env.WINDSURFAPI_MAX_DRAIN_MS;
      }
      assert.equal(registry.detachedRegistry.stats().admit, 0);
      assert.ok(registry.detachedRegistry.stats().refuse.not_client_gone >= 1);
      assert.equal(lsFake.activeRequests, 0);
    });
  });
});

// ── T14/T18: concurrency and re-detach ──────────────────────
describe('Detach P1 claim discipline', () => {
  it('T14 two identical retries: one claims, the other stays foreground', async () => {
    const acct = seedAccount('t14');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t14');
      const ctx = handlerContext(port, acct, lsFake);
      await runToCompletion(body, ctx, { closeAfterWrites: 2 });
      assert.equal(registry.detachedRegistry.stats().admit, 1);

      state.status = 'idle';
      state.grown = true;
      state.resumeDelayMs = 60;
      const first = await startStream(body, ctx);
      const firstRes = makeResponse({});
      const firstRun = first.handler(firstRes.res);
      // Give the first request time to claim before the second looks up.
      await new Promise(resolve => setTimeout(resolve, 15));
      const second = await startStream(body, ctx);
      const secondRes = makeResponse({});
      await second.handler(secondRes.res);
      await firstRun;

      assert.equal(registry.detachedRegistry.stats().claim.ok, 1);
      assert.equal(registry.detachedRegistry.stats().claim.busy, 1);
      assert.equal(registry.detachedRegistry.stats().serve, 1);
      assert.equal(state.startCalls, 2, 'the busy retry starts its own upstream turn');
      assert.ok(contentOf(firstRes.state).includes(GROWTH));
      assert.equal(contentOf(secondRes.state), FULL_TEXT, 'the busy retry still answers from upstream');
      assert.equal(lsFake.activeRequests, 0);
    });
  });

  it('T18 a re-detach keeps the entry claimable and does not extend its TTL', async () => {
    const acct = seedAccount('t18');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('t18');
      const ctx = handlerContext(port, acct, lsFake);
      await runToCompletion(body, ctx, { closeAfterWrites: 2 });
      const key = detachKeyOf(body);
      const originalExpiry = registry.detachedRegistry.lookup(key, ctx.callerKey).expiresAt;

      state.status = 'idle';
      state.grown = true;
      // The first retry dies on the FIRST NEW content write: role (1),
      // replayed prefix (2), new growth (3).
      await runToCompletion(body, ctx, { closeAfterWrites: 3 });
      assert.equal(registry.detachedRegistry.stats().re_detach, 1);
      assert.equal(registry.detachedRegistry.stats().serve, 0);
      const reDetached = registry.detachedRegistry.lookup(key, ctx.callerKey);
      assert.ok(reDetached, 'the entry is running again');
      assert.equal(reDetached.expiresAt, originalExpiry, 'a re-detach must not extend the TTL');
      assert.equal(reDetached.snapshot.chunks.map(chunk => chunk.text || '').join(''), FULL_TEXT);

      // The second retry finishes; the final body has each byte exactly once.
      state.firstResumeRead = true;
      const { state: finalState } = await runToCompletion(body, ctx, {});
      assert.equal(registry.detachedRegistry.stats().serve, 1);
      assert.equal(registry.detachedRegistry.stats().entries, 0);
      assert.equal(contentOf(finalState), FULL_TEXT);
      assert.equal(finalState.body.split(PREFIX).length - 1, 1);
      assert.equal(finalState.body.split(GROWTH).length - 1, 1);
      assert.equal(state.startCalls, 1, 'no retry ever started a new cascade');
      assert.equal(state.sendCalls, 1, 'no retry ever re-sent the user message');
    });
  });
});

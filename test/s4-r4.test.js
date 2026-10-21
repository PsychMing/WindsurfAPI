import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function run(options = {}) {
  const source = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
  const start = source.indexOf('        // All attempts failed\n');
  const end = source.indexOf('      } finally {\n        unregisterSse();', start);
  assert.ok(start >= 0 && end > start, 'execute the actual failure continuation, not a copied decision tree');
  const block = source.slice(start, end);
  const warnings = [], fallback = [], writes = [], visited = [];
  const boom = () => { throw new Error('sensitive-token-in-error'); };
  const res = {
    writableEnded: false,
    endAttempts: 0,
    write(text) {
      if (options.errorWrite && text.includes('"error"')) boom();
      if (options.doneWrite && text === 'data: [DONE]\n\n') boom();
      if (options.finishWrite && text.includes('"finish_reason":"stop"')) boom();
      writes.push(text); return true;
    },
    end() { this.endAttempts += 1; if (options.endFail) boom(); this.writableEnded = true; },
  };
  // Collaborator contract: this unchanged helper emits one finish then DONE.
  // The separate full-handler integration test also exercises its real definition.
  function finishPartialStreamAfterError({ id, created, model, send, res, internalRoute }) {
    send({ id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(internalRoute ? { __synthetic_finish: true } : {}) });
    if (res && !res.writableEnded) res.write('data: [DONE]\n\n');
  }
  const deps = {
    options, res, visited, lastErr: new Error('upstream failed'), model: 'model', modelKey: 'model',
    startTime: 0, currentApiKey: 'test-key', reqId: 'request', id: 'completion', created: 1,
    tried: ['key'], streamInternalCount: 0, hadSuccess: false, reuseEntryDead: false,
    checkedOutReuseEntry: null, fpBefore: null, callerKey: '', cachePolicy: null,
    deps: { wantThinking: false }, collectedToolCalls: [], isOpenAIClient: !options.internal,
    log: { error: options.logErrorFail ? boom : () => {}, info() {},
      warn: options.logWarnFail ? boom : line => warnings.push(line) },
    process: { stderr: { write: line => fallback.push(line) } },
    safeKeyRef: (text, prefix) => `${prefix}Hash=${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
    recordRequest() {}, isAllTemporarilyUnavailable: options.classifyFail ? boom : () => ({ allUnavailable: false }),
    isAllRateLimited: () => ({ allLimited: false }), isLsPoolExhausted: () => false,
    isUpstreamDeadlineExceeded: () => false, isCascadeTransportError: () => false,
    isBudgetExceededError: () => false,
    upstreamTransientErrorMessage: () => 'transient', upstreamDeadlineExceededMessage: () => 'deadline',
    sanitizeText: x => x, poolCheckin() {}, ttlHintFromCachePolicy() {},
    pathStreamText: { flush() { visited.push('egress'); if (options.pathFail) boom(); return ''; } },
    thinkClassifier: { flush() { visited.push('think'); return ''; } },
    reasoningDedup: { release() { visited.push('dedup'); if (options.dedupFail) boom(); return ''; } },
    // The stop gate is owned outside this extracted continuation; real handler tests cover its bytes.
    flushContentGate: options.gateFail ? boom : () => {},
    shouldFallbackThinkingToText: () => false, finishPartialStreamAfterError: options.helperFail ? boom : finishPartialStreamAfterError,
    chatStreamError: (message, type, code) => ({ error: { message, type, code } }),
    // C2 writer gate. This harness models a writable that never reports
    // backpressure, so the gate is a no-op here: the assertions below stay about
    // failure isolation, not about draining. The real drain contract is pinned
    // end-to-end in test/stream-backpressure-drain.test.js.
    writerGone: () => res.writableEnded,
    awaitWriter: async () => {},
    settleWriter: async () => {},
    pendingEmission: null,
  };
  await new Function(...Object.keys(deps), `
    return (async () => {
      let emittedClientPayload = !!options.partial, accThinking = '', accText = '';
      const writeRaw = text => res.write(text);
      const send = frame => writeRaw('data: ' + JSON.stringify(frame) + '\\n\\n');
      const emitContent = text => { emittedClientPayload = true; return send({ content: text }); };
      const emitThinking = emitContent;
      ${block}
    })();
  `)(...Object.values(deps));
  return { warnings, fallback, writes, visited, res };
}
const done = r => r.writes.filter(x => x === 'data: [DONE]\n\n').length;

test('R4 an error-frame-only write failure ends without DONE and reports one redacted warn', async () => {
  const r = await run({ errorWrite: true });
  assert.equal(done(r), 0, 'a pre-content failure must not claim a clean finish');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /stage=error-frame/);
  assert.doesNotMatch(r.warnings.join(''), /sensitive-token-in-error/);
  assert.equal(r.res.writableEnded, true);
  assert.equal(r.res.endAttempts, 1, 'the failed error-frame write must not skip end');
});

test('R4 a broken warning logger uses the fallback sink and still ends without DONE', async () => {
  const r = await run({ errorWrite: true, logWarnFail: true });
  assert.equal(done(r), 0);
  assert.equal(r.fallback.length, 1);
  assert.match(r.fallback[0], /stage=error-frame.*logger=failed/);
  assert.equal(r.res.endAttempts, 1);
});

test('R4 a failed DONE write on a partial failure keeps the synthetic finish and still ends', async () => {
  const r = await run({ partial: true, doneWrite: true });
  assert.ok(r.writes.some(x => x.includes('"finish_reason":"stop"')), 'the synthetic finish must already be on the wire');
  assert.equal(r.writes.some(x => x.includes('"error"')), false, 'a partial failure has no error frame');
  assert.match(r.warnings.join(''), /stage=done/);
  assert.equal(r.res.writableEnded, true);
  assert.equal(r.res.endAttempts, 1);
});

test('R4 a flush failure does not suppress other flushes or the error frame', async () => {
  const r = await run({ pathFail: true });
  assert.deepEqual(r.visited, ['egress', 'think']);
  assert.ok(r.writes.some(x => x.includes('"error"')));
  assert.equal(done(r), 0, 'a pre-content failure ends on the error frame');
  assert.match(r.warnings.join(''), /stage=egress-tail/);
  assert.equal(r.res.endAttempts, 1);
});

test('R4 a failed held tail or synthetic finish cannot prevent partial DONE', async () => {
  for (const flags of [{ dedupFail: true }, { finishWrite: true }, { helperFail: true }]) {
    const r = await run({ partial: true, internal: true, ...flags });
    assert.equal(done(r), 1);
    assert.equal(r.writes.some(x => x.includes('"error"')), false);
    assert.match(r.warnings.join(''), /stage=(dedup-tail|finish-frame)/);
  }
});

test('R4 synthetic finish markers remain internal-only and successful termination is single-shot', async () => {
  for (const internal of [false, true]) {
    const r = await run({ partial: true, internal });
    const finish = JSON.parse(r.writes[0].slice(6));
    assert.equal(finish.choices[0].finish_reason, 'stop');
    assert.equal(Object.hasOwn(finish, '__synthetic_finish'), internal);
    assert.equal(done(r), 1);
  }
});

test('R4 classification and ordinary error logging cannot block terminal delivery', async () => {
  for (const flags of [{ classifyFail: true }, { logErrorFail: true }]) {
    const r = await run(flags);
    assert.equal(done(r), 0, 'a pre-content failure has no success sentinel');
    assert.equal(r.res.writableEnded, true);
    assert.equal(r.res.endAttempts, 1);
    assert.equal(r.warnings.length, 1);
  }
});

test('R4 end failures are diagnosed rather than escaping the finalizer', async () => {
  const r = await run({ endFail: true });
  assert.equal(done(r), 0);
  assert.match(r.warnings.join(''), /stage=end/);
  assert.equal(r.res.endAttempts, 1, 'the end attempt must still happen');
});

test('R4 a stop-gate flush failure still delivers the error frame and ends without DONE', async () => {
  const r = await run({ gateFail: true });
  assert.equal(done(r), 0);
  assert.ok(r.writes.some(x => x.includes('"error"')));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /stage=content-gate-tail/);
  assert.equal(r.res.writableEnded, true);
  assert.equal(r.res.endAttempts, 1);
});

test('R4 a pre-content failure never writes the success sentinel', async () => {
  // Explicit guard against restoring the unconditional DONE stage: the error
  // frame is the last signal a pre-content failure is allowed to emit.
  const r = await run({});
  assert.ok(r.writes.some(x => x.includes('"error"')));
  assert.equal(done(r), 0);
  assert.equal(r.writes.at(-1).includes('"error"'), true, 'the error frame must be the last write');
  assert.equal(r.res.writableEnded, true);
  assert.equal(r.res.endAttempts, 1);
});

// V-10 (KH-013) — structured output was "stabilised" by INVENTING values.
//
// MEASURED on the audited baseline: for a request whose user turn asked for the
// exact keys `readVersion, bashVersion, versionsMatch`, a model that answered
// `{"name":"windsurf-api","version":"2.0.11"}` had its answer rewritten into
// `{"readVersion":"2.0.11","bashVersion":"2.0.11","versionsMatch":true}` —
// `readVersion`/`bashVersion` were lifted out of unrelated tool results by name
// matching, and `versionsMatch` was a comparison the model never made. A
// requested key with no supporting value became `null`, and the literal key `ok`
// became `true`. None of those values were in the model's output.
//
// And a `response_format: {type:'json_schema'}` request was never validated at
// all: the proxy returned 200 for a body the caller's own validator rejects.
//
// The contract this file pins:
//   * only values the model actually emitted are projected;
//   * a missing key stays missing (never `null`, never `true`);
//   * a supplied schema is checked, and a non-conforming answer is a typed
//     failure on every surface that post-processes the payload;
//   * a plain `json_object` request (no schema) keeps its old behaviour.

process.env.DEVIN_CONNECT = '0';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleChatCompletions,
  stabilizeJsonPayload,
  structuredOutputViolation,
  __resetConnectDeps,
  __setConnectDeps,
} from '../src/handlers/chat.js';
import { validateJsonSchema } from '../src/json-schema.js';
import { addAccountByKey, getApiKey, removeAccount } from '../src/auth.js';

const CALLER = 'api:v10:user:u1';
const MODEL = 'swe-1-6-slow';
// A name the Cascade catalog actually resolves — `swe-1-6-*` are connect selectors.
const CASCADE_MODEL = 'gemini-2.5-flash';
const created = [];
let savedDevinConnect = null;

function seedAccount(label) {
  const a = addAccountByKey(`v10-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  return a;
}

beforeEach(() => {
  savedDevinConnect = process.env.DEVIN_CONNECT;
});

afterEach(() => {
  __resetConnectDeps();
  if (savedDevinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = savedDevinConnect;
  while (created.length) {
    try { removeAccount(created.pop()); } catch {}
  }
});

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'number' }, unit: { type: 'string' } },
  required: ['answer', 'unit'],
  additionalProperties: false,
};

function schemaBody(extra = {}) {
  return {
    model: MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'Give me the measurement as JSON with answer and unit.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'measurement', strict: true, schema: SCHEMA } },
    ...extra,
  };
}

function connectDeps(content) {
  __setConnectDeps({
    toChatCompletion: async () => ({
      status: 200,
      body: {
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    }),
  });
}

describe('V-10: the projection only keeps values the model produced', () => {
  const driftMessages = [
    { role: 'user', content: 'After both tool results, answer only compact JSON with exact keys readVersion, bashVersion, versionsMatch and no other keys.' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_read', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_read', content: '{"name":"windsurf-api","version":"2.0.11"}' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_bash', type: 'function', function: { name: 'Bash', arguments: '{"command":"node -p version"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_bash', content: '2.0.11' },
  ];

  it('a model that drifts is not repaired with invented values', () => {
    const out = stabilizeJsonPayload('{"name":"windsurf-api","version":"2.0.11"}', driftMessages);
    assert.doesNotMatch(out, /readVersion|bashVersion/, 'values lifted out of tool results are invented facts');
    assert.doesNotMatch(out, /versionsMatch/, 'the model never made that comparison');
    assert.equal(out, '{"name":"windsurf-api","version":"2.0.11"}', 'with nothing projectable, the model payload is the honest answer');
  });

  it('a requested key the model omitted is absent, not null and not true', () => {
    const messages = [
      { role: 'user', content: 'Answer only compact JSON with exact keys ok, detail and no other keys.' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'all good' },
    ];
    const out = JSON.parse(stabilizeJsonPayload('{"detail":"fine"}', messages));
    assert.equal(out.detail, 'fine');
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'ok'), false,
      '`ok: true` was a literal the model never wrote');
  });

  it('versionsMatch is still derived, but only from two values the model emitted', () => {
    const messages = [
      { role: 'user', content: 'Answer only compact JSON with exact keys readVersion, bashVersion, versionsMatch and no other keys.' },
    ];
    const out = JSON.parse(stabilizeJsonPayload('{"readVersion":"2.0.11","bashVersion":"2.0.11"}', messages));
    assert.deepEqual(out, { readVersion: '2.0.11', bashVersion: '2.0.11', versionsMatch: true });
  });

  it('structuredOutputViolation names the first violation and stays silent without a schema', () => {
    assert.equal(structuredOutputViolation('{"answer":1,"unit":"m"}', SCHEMA), null);
    assert.deepEqual(structuredOutputViolation('{"answer":1}', SCHEMA), { path: '$', message: 'missing required property "unit"' });
    assert.equal(structuredOutputViolation('not json at all', SCHEMA).path, '$');
    assert.equal(structuredOutputViolation('not json at all', null), null, 'json_object carries no schema to check');
  });

  it('the validator enforces the keywords callers actually ship', () => {
    assert.equal(validateJsonSchema({ a: 1 }, { type: 'object', required: ['a'] }).ok, true);
    assert.equal(validateJsonSchema({ a: 1, b: 2 }, { type: 'object', additionalProperties: false }).ok, false);
    assert.equal(validateJsonSchema({ a: 'x' }, { type: 'object', properties: { a: { type: 'number' } } }).ok, false);
    assert.equal(validateJsonSchema([1, 2], { type: 'array', items: { type: 'integer' }, maxItems: 2 }).ok, true);
    assert.equal(validateJsonSchema('b', { enum: ['a', 'b'] }).ok, true);
    assert.equal(validateJsonSchema('c', { enum: ['a', 'b'] }).ok, false);
    // Unknown keywords are annotations, never failures.
    assert.equal(validateJsonSchema({ a: 1 }, { type: 'object', 'x-unknown': { nope: true } }).ok, true);
  });
});

describe('V-10: a supplied schema is checked on the surfaces that post-process the answer', () => {
  it('Connect non-stream: a non-conforming answer is a typed failure, not a 200', async () => {
    process.env.DEVIN_CONNECT = '1';
    seedAccount('connect-bad');
    connectDeps('{"answer":"twelve"}');
    const result = await handleChatCompletions(schemaBody(), { callerKey: CALLER });
    assert.equal(result.status, 502, `expected a structured-output failure, got ${result.status} ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error.code, 'STRUCTURED_OUTPUT_NOT_CONFORMING');
    assert.match(result.body.error.message, /does not conform/);
    assert.match(result.body.error.message, /unit|number/);
  });

  it('Connect non-stream: a conforming answer passes through unchanged', async () => {
    process.env.DEVIN_CONNECT = '1';
    seedAccount('connect-ok');
    connectDeps('{"answer":12,"unit":"m"}');
    const result = await handleChatCompletions(schemaBody(), { callerKey: CALLER });
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, '{"answer":12,"unit":"m"}');
  });

  it('Connect non-stream: json_object without a schema is not validated against one', async () => {
    process.env.DEVIN_CONNECT = '1';
    seedAccount('connect-json-object');
    connectDeps('{"anything":true}');
    const result = await handleChatCompletions(
      schemaBody({ response_format: { type: 'json_object' } }),
      { callerKey: CALLER },
    );
    assert.equal(result.status, 200, 'there is no schema to violate');
  });
});

/** Cascade stream harness: the handler's own client seam, nothing faked deeper. */
function cascadeDeps(text) {
  class FakeClient {
    async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
      if (opts.onChunk) await opts.onChunk({ text, thinking: '', isError: false });
      const chunks = [];
      chunks.toolCalls = [];
      chunks.totalYielded = text.length;
      chunks.totalThinking = 0;
      return chunks;
    }
  }
  return {
    waitForAccount(tried) { return tried.length === 0 ? getApiKey(tried) : null; },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17888, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
    callerKey: CALLER,
  };
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
    once(event, cb) { this.on(event, cb); return this; },
    removeListener() {},
    writeHead() { return this; },
  };
}

function frames(res) {
  return res.body.split('\n\n').filter(Boolean).map((frame) => {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return null;
    try { return JSON.parse(line.slice(6)); } catch { return null; }
  }).filter(Boolean);
}

describe('V-10: the Cascade stream reports a schema miss instead of a clean stop', () => {
  it('a non-conforming JSON answer closes with a typed error and no finish_reason stop', async () => {
    process.env.DEVIN_CONNECT = '0';
    seedAccount('cascade-bad');
    const result = await handleChatCompletions(
      { ...schemaBody({ stream: true, model: CASCADE_MODEL }), messages: [{ role: 'user', content: 'Answer as JSON.' }] },
      cascadeDeps('{"answer":"twelve"}'),
    );
    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);

    const chunks = frames(res);
    const errors = chunks.filter((c) => c.error);
    assert.equal(errors.length, 1, `expected one error frame, got ${JSON.stringify(chunks)}`);
    assert.equal(errors[0].error.code, 'STRUCTURED_OUTPUT_NOT_CONFORMING');
    assert.equal(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'), false,
      'a clean stop would claim the schema held');
    assert.equal(res.body.includes('data: [DONE]'), false, 'no clean-finish sentinel on a failure');
    assert.doesNotMatch(res.body, /"answer":"twelve"/, 'the non-conforming payload must not be delivered');
  });

  it('control: a conforming JSON answer streams and finishes normally', async () => {
    process.env.DEVIN_CONNECT = '0';
    seedAccount('cascade-ok');
    const result = await handleChatCompletions(
      { ...schemaBody({ stream: true, model: CASCADE_MODEL }), messages: [{ role: 'user', content: 'Answer as JSON.' }] },
      cascadeDeps('{"answer":12,"unit":"m"}'),
    );
    const res = fakeRes();
    await result.handler(res);
    const chunks = frames(res);
    const content = chunks
      .flatMap((c) => c.choices || [])
      .map((c) => c.delta?.content || '')
      .join('');
    assert.equal(content, '{"answer":12,"unit":"m"}');
    assert.equal(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'), true);
    assert.ok(res.body.includes('data: [DONE]'));
  });
});

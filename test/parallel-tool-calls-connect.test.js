// `parallel_tool_calls:false` is a CALLER CORRECTNESS HINT — "emit at most one
// tool call per turn". Live matrix evidence (evidence/ToolMatrixLive.md §8, 2026-10):
// 4/4 DEVIN_CONNECT models still emitted two calls with the flag set false,
// because the flag never reached the wire: the #11 `disable_parallel_tool_calls`
// field is gated behind DEVIN_CONNECT_TOOL_CHOICE=1 (unconfirmed tag, default
// off), AND streamChat() did not forward the parameter at all.
//
// Silently ignoring the hint is the bug: a client that applies tool calls as
// side effects, one result at a time, cannot tell the proxy dropped its
// correctness requirement. The proxy also cannot serialise calls it does not
// control — the upstream has already decided to emit N calls in one turn, and
// dropping N-1 would lose work — so the two honest behaviours are:
//
//   switch ON  → honour natively (#11 on the wire; the operator calibrated it).
//   switch OFF → 400 unsupported_parameter naming the switch, instead of
//                pretending the request was honoured.
//
// The rejection is scoped to the connect flow on purpose: the switch and the
// wire field are connect-only, so a Cascade request must not be refused over a
// connect knob. See evidence/ToolChoiceFlag.md.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { streamChat, __setRequestImpl } from '../src/devin-connect.js';
import { endOfStreamEnvelope } from '../src/connect.js';
import { parseFields } from '../src/proto.js';

const TOKEN = 'devin-session-token$parallel-tool-calls.test.jwt.sig';

const request = (extra) => ({
  model: 'claude-5-fable-medium',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

const okBody = () => ({
  status: 200,
  body: {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'claude-5-fable-medium',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
});

// Capture what the handler hands the connect layer, without a network turn.
function stubConnect() {
  const seen = [];
  __setConnectDeps({
    toChatCompletion: async (params) => { seen.push(params); return okBody(); },
  });
  return seen;
}

afterEach(() => {
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
  __resetConnectDeps();
  __setRequestImpl(null);
});

describe('parallel_tool_calls:false is never silently dropped (connect route)', () => {
  it('rejects with 400 unsupported_parameter when the passthrough switch is off', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = stubConnect();

    const r = await handleChatCompletions(request({ parallel_tool_calls: false }));

    assert.equal(r.status, 400, JSON.stringify(r?.body));
    assert.equal(r.body.error.type, 'invalid_request_error');
    assert.equal(r.body.error.code, 'unsupported_parameter',
      'the caller must be able to distinguish "not honoured" from a generic bad request');
    assert.equal(r.body.error.param, 'parallel_tool_calls');
    assert.match(r.body.error.message, /parallel_tool_calls/);
    assert.match(r.body.error.message, /DEVIN_CONNECT_TOOL_CHOICE/,
      'the message must name the switch that makes the hint honourable');
    assert.equal(seen.length, 0, 'the rejection must precede every upstream turn');
  });

  it('forwards parallel_tool_calls:false to the connect layer when the switch is on', async () => {
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOOL_CHOICE = '1';
    const seen = stubConnect();

    const r = await handleChatCompletions(request({ parallel_tool_calls: false }));

    assert.notEqual(r.status, 400, `the honoured path must not be rejected: ${JSON.stringify(r?.body)}`);
    assert.equal(seen.length, 1, 'exactly one connect turn');
    assert.equal(seen[0].parallelToolCalls, false,
      'the flag must reach buildGetChatMessageRequest, not stop at the handler');
  });

  it('forwards tool_choice on the same switch (the other half of the same gate)', async () => {
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOOL_CHOICE = '1';
    const seen = stubConnect();

    await handleChatCompletions(request({ tool_choice: 'required' }));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].toolChoice, 'required',
      'tool_choice is inert on the live route too unless the handler threads it');
  });

  it('accepts parallel_tool_calls:true — the upstream default needs no field', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = stubConnect();

    const r = await handleChatCompletions(request({ parallel_tool_calls: true }));

    assert.notEqual(r.status, 400, JSON.stringify(r?.body));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].parallelToolCalls, true);
  });

  it('accepts an absent parallel_tool_calls', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = stubConnect();

    const r = await handleChatCompletions(request({}));

    assert.notEqual(r.status, 400, JSON.stringify(r?.body));
    assert.equal(seen.length, 1);
  });

  it('does not reject on the Cascade route — the knob and the wire field are connect-only', async () => {
    delete process.env.DEVIN_CONNECT;
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    stubConnect();

    const r = await handleChatCompletions({
      model: 'totally-made-up-model-xyz',
      messages: [{ role: 'user', content: 'hi' }],
      parallel_tool_calls: false,
    });

    // The Cascade path rejects the unknown model for its own reason; the point is
    // that it is NOT the connect-only parallel_tool_calls gate — and that the request
    // really did reach Cascade's model gate (a 200 or a 500 would prove nothing).
    assert.equal(r.status, 400);
    assert.equal(r.body?.error?.param, 'model', 'Cascade must answer about the model, not the connect knob');
    assert.equal(r.body?.error?.code, 'model_not_found');
    assert.notEqual(r.body?.error?.code, 'unsupported_parameter',
      'a connect switch must not refuse a Cascade request');
  });
});

describe('/v1/messages: the same hint is refused in Anthropic vocabulary', () => {
  it('names tool_choice.disable_parallel_tool_use instead of the internal field', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;

    // Real chain: handleMessages → handleChatCompletions → the connect gate. The
    // gate fires before any account is acquired, so no network turn is possible.
    const r = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(r.status, 400, JSON.stringify(r?.body));
    assert.equal(r.body.error.type, 'invalid_request_error');
    assert.match(r.body.error.message, /disable_parallel_tool_use/,
      'the client must be told which parameter it actually sent');
    assert.doesNotMatch(r.body.error.message, /parallel_tool_calls:false on the/i,
      'the OpenAI-shaped internal message must not leak through verbatim');
    assert.notEqual(r.body.error.message, 'Invalid request',
      'the internal backend name must not trip the leak filter into an opaque generic error');
  });
});

describe('streamChat threads the opt-in tool fields to the wire', () => {
  // Transport seam: capture the exact bytes the request sends, then answer with an
  // empty end-of-stream trailer so the generator drains.
  function captureRequest() {
    const captured = { body: null };
    __setRequestImpl((_opts, cb) => {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = () => {};
      req.write = (buf) => { captured.body = Buffer.from(buf); };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.pause = () => {};
        res.resume = () => {};
        cb(res);
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      };
      return req;
    });
    return captured;
  }

  // Request frames are written UNCOMPRESSED (connect.js: the upstream rejects a
  // gzipped request), so the proto is the payload after the 5-byte frame header.
  const protoOf = (body) => body.subarray(5);
  const hasField = (proto, n) => parseFields(proto).some((f) => f.field === n);

  async function drain(params) {
    for await (const _ev of streamChat(params)) { /* drain */ }
  }

  const base = {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'claude-sonnet-4.6',
    token: TOKEN,
  };

  it('emits #11 when the switch is on and the caller said false', async () => {
    const captured = captureRequest();
    await drain({
      ...base,
      parallelToolCalls: false,
      env: { DEVIN_CONNECT_TOKEN: TOKEN, DEVIN_CONNECT_TOOL_CHOICE: '1' },
    });
    assert.ok(captured.body, 'a request was written');
    assert.equal(hasField(protoOf(captured.body), 11), true,
      'disable_parallel_tool_calls must be on the wire, not swallowed by streamChat');
  });

  it('emits #12 for a non-default tool_choice when the switch is on', async () => {
    const captured = captureRequest();
    await drain({
      ...base,
      toolChoice: 'required',
      env: { DEVIN_CONNECT_TOKEN: TOKEN, DEVIN_CONNECT_TOOL_CHOICE: '1' },
    });
    assert.equal(hasField(protoOf(captured.body), 12), true);
  });

  it('emits neither field when the switch is off (default wire unchanged)', async () => {
    const captured = captureRequest();
    await drain({
      ...base,
      toolChoice: 'required',
      parallelToolCalls: false,
      env: { DEVIN_CONNECT_TOKEN: TOKEN },
    });
    const proto = protoOf(captured.body);
    assert.equal(hasField(proto, 11), false);
    assert.equal(hasField(proto, 12), false);
  });
});

// Signed Claude thinking: decode → client → native replay (#11 thinking + #12 signature).
//
// Measured 2026-10-28 on claude-opus-5-5 (paid account, direct upstream calls):
//   - the upstream returns the signature as response #10 (base64 string) right
//     after the last reasoning frame and before content;
//   - replaying it as #11 + #12 on the role=2 tool-call frames is VERIFIED
//     (one changed character → invalid_argument, 3/3) and the model then recalls
//     the replayed thinking inside the tool loop (2/2; #11 alone 0/3).
// These tests pin the three hops so the signature can never silently fall off.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGetChatMessageRequest, __testing } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';
import {
  toChatCompletion,
  streamChatCompletion,
  __setStreamChatForTest,
} from '../src/devin-connect-openai.js';
import { handleMessages, signedThinkingReplayEnabled } from '../src/handlers/messages.js';
import { __setConnectDeps } from '../src/handlers/chat.js';

const TOKEN = 'test$token';
const SIG = 'EpkCCkYIBxgCKkDsignatureBase64Payload==';

function wireChats(proto) {
  return getAllFields(parseFields(proto), 3)
    .filter((f) => f.wireType === 2)
    .map((f) => parseFields(f.value));
}
const str = (fields, n) => getField(fields, n, 2)?.value.toString('utf8') ?? null;

describe('wire: signed thinking on an assistant tool-call turn', () => {
  const toolTurn = (extra = {}) => ([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: 'checking',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
      ...extra,
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'r1' },
    { role: 'tool', tool_call_id: 'call_2', content: 'r2' },
  ]);

  it('writes #11 thinking and #12 signature on every role=2 frame of the turn', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', nativeToolCall: true, env: {},
      messages: toolTurn({ reasoning_content: 'secret is 482917', reasoning_signature: SIG }),
    });
    const assistant = wireChats(proto).filter((c) => Number(getField(c, 2, 0).value) === __testing.SOURCE.ASSISTANT);
    // preText frame + one frame per call
    assert.equal(assistant.length, 3);
    for (const c of assistant) {
      assert.equal(str(c, 11), 'secret is 482917');
      assert.equal(str(c, 12), SIG);
    }
  });

  it('emits neither field without a signature (default wire unchanged)', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', nativeToolCall: true, env: {},
      messages: toolTurn({ reasoning_content: 'unsigned' }),
    });
    for (const c of wireChats(proto)) {
      assert.equal(getField(c, 11, 2), null);
      assert.equal(getField(c, 12, 2), null);
    }
  });

  it('does not double #11 when the REPLAY_REASONING probe is also on', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', nativeToolCall: true, env: { DEVIN_CONNECT_REPLAY_REASONING: '1' },
      messages: toolTurn({ reasoning_content: 'signed', reasoning_signature: SIG }),
    });
    const first = wireChats(proto)[1];
    assert.equal(first.filter((f) => f.field === 11).length, 1);
    assert.equal(str(first, 12), SIG);
  });
});

describe('adapter: signature reaches the OpenAI-shaped response', () => {
  afterEach(() => __setStreamChatForTest(null));
  const fake = (events) => async function* () { for (const ev of events) yield ev; };
  const SIGNED = [
    { type: 'reasoning', text: 'think' },
    { type: 'signature', reasoning_signature: 'Ep' },
    { type: 'signature', reasoning_signature: 'kC' },
    { type: 'content', text: 'answer' },
    { type: 'finish', reason: 'stop', usage: null, reasoning_signature: 'EpkC' },
  ];

  it('non-stream: message.reasoning_signature is the concatenated increments', async () => {
    __setStreamChatForTest(fake(SIGNED));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    assert.equal(body.choices[0].message.reasoning_content, 'think');
    assert.equal(body.choices[0].message.reasoning_signature, 'EpkC');
  });

  const choicesOf = (frames) => frames.flatMap((f) => f.choices || []);

  it('stream: the increments go out as one delta, right before the first text', async () => {
    __setStreamChatForTest(fake(SIGNED));
    const frames = [];
    await streamChatCompletion({ model: 'm', messages: [] }, (d) => frames.push(d));
    const order = choicesOf(frames)
      .map((c) => (c.delta?.reasoning_signature ? `sig:${c.delta.reasoning_signature}` : c.delta?.content ? 'text' : c.delta?.reasoning_content ? 'think' : null))
      .filter(Boolean);
    assert.deepEqual(order, ['think', 'sig:EpkC', 'text']);
  });

  it('stream: a tool-call-only answer is sealed at end of stream, before the tool call', async () => {
    __setStreamChatForTest(fake([
      { type: 'reasoning', text: 'think' },
      { type: 'signature', reasoning_signature: 'EpkC' },
      { type: 'finish', reason: 'tool_calls', usage: null, toolCalls: [{ id: 'toolu_1', name: 'log_event', arguments: '{}' }] },
    ]));
    const frames = [];
    await streamChatCompletion({ model: 'm', messages: [] }, (d) => frames.push(d));
    const order = choicesOf(frames)
      .map((c) => (c.delta?.reasoning_signature ? 'sig' : c.delta?.tool_calls ? 'call' : null))
      .filter(Boolean);
    assert.deepEqual(order, ['sig', 'call']);
  });

  const RESCUED = [
    { type: 'reasoning', text: 'first' },
    { type: 'signature', reasoning_signature: 'OLD' },
    { type: 'attempt_reset' },
    { type: 'reasoning', text: 'second' },
    { type: 'signature', reasoning_signature: 'NEW' },
    { type: 'content', text: 'answer' },
    { type: 'finish', reason: 'stop', usage: null },
  ];

  it('stream (Messages route): a rescue breaks the thinking block and seals only the final attempt', async () => {
    __setStreamChatForTest(fake(RESCUED));
    const frames = [];
    await streamChatCompletion({ model: 'm', messages: [] }, (d) => frames.push(d), { stopCarrier: true });
    const order = choicesOf(frames)
      .map((c) => (c._windsurf_reasoning_break ? 'break' : c.delta?.reasoning_signature ? `sig:${c.delta.reasoning_signature}` : c.delta?.reasoning_content ? `think:${c.delta.reasoning_content}` : null))
      .filter(Boolean);
    assert.deepEqual(order, ['think:first', 'break', 'think:second', 'sig:NEW']);
  });

  it('stream (plain OpenAI route): no break carrier leaks out', async () => {
    __setStreamChatForTest(fake(RESCUED));
    const frames = [];
    await streamChatCompletion({ model: 'm', messages: [] }, (d) => frames.push(d));
    assert.equal(choicesOf(frames).some((c) => '_windsurf_reasoning_break' in c), false);
  });

  it('non-stream: a rescue keeps only the final attempt signature', async () => {
    __setStreamChatForTest(fake([
      { type: 'reasoning', text: 'first' },
      { type: 'signature', reasoning_signature: 'OLD' },
      { type: 'attempt_reset' },
      { type: 'reasoning', text: 'second' },
      { type: 'signature', reasoning_signature: 'NEW' },
      { type: 'content', text: 'answer' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    assert.equal(body.choices[0].message.reasoning_signature, 'NEW');
  });
});

describe('/v1/messages: signed thinking survives into the connect request', () => {
  const KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'DEVIN_CONNECT_REPLAY_SIGNED_THINKING', 'WINDSURFAPI_STRICT_MODEL'];
  const saved = {};
  let seen = null;
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOKEN = TOKEN;
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    delete process.env.WINDSURF_API_KEY;
    seen = null;
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen = params;
        return { status: 200, body: { id: 'x', object: 'chat.completion', created: 0, model: params.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
      },
    });
  });
  afterEach(() => {
    __setConnectDeps(null);
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  const body = (thinkingBlocks) => ({
    model: 'claude-opus-4.8', max_tokens: 64,
    tools: [{ name: 'log_event', description: 'log', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [...thinkingBlocks, { type: 'tool_use', id: 'toolu_1', name: 'log_event', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'logged' }] },
    ],
  });
  const assistantWithCalls = () => seen.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length);

  it('is off by default: thinking is not replayed', async () => {
    delete process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING;
    assert.equal(signedThinkingReplayEnabled(), false);
    await handleMessages(body([{ type: 'thinking', thinking: 't', signature: SIG }]), { callerKey: 'sig-test' });
    assert.ok(seen, 'precondition: the connect adapter ran');
    assert.equal(assistantWithCalls().reasoning_signature, undefined);
  });

  it('when on, the signed block rides the tool-call turn to the connect adapter', async () => {
    process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = '1';
    await handleMessages(body([{ type: 'thinking', thinking: 'secret 482917', signature: SIG }]), { callerKey: 'sig-test' });
    const a = assistantWithCalls();
    assert.equal(a.reasoning_content, 'secret 482917');
    assert.equal(a.reasoning_signature, SIG);
  });

  it('when on, an unsigned turn, two signed blocks, or a signed block followed by an unsigned one is not replayed', async () => {
    process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = '1';
    for (const blocks of [
      [{ type: 'thinking', thinking: 't', signature: '' }],
      [{ type: 'thinking', thinking: 'a', signature: SIG }, { type: 'thinking', thinking: 'b', signature: SIG }],
      [{ type: 'thinking', thinking: 'a', signature: SIG }, { type: 'thinking', thinking: 'b', signature: '' }],
    ]) {
      await handleMessages(body(blocks), { callerKey: 'sig-test' });
      assert.equal(assistantWithCalls().reasoning_signature, undefined, JSON.stringify(blocks.map((b) => !!b.signature)));
    }
  });

  it('when on, an abandoned unsigned rescue block before the signed one is skipped', async () => {
    process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = '1';
    await handleMessages(body([
      { type: 'thinking', thinking: 'abandoned attempt', signature: '' },
      { type: 'thinking', thinking: 'final attempt', signature: SIG },
    ]), { callerKey: 'sig-test' });
    const a = assistantWithCalls();
    assert.equal(a.reasoning_content, 'final attempt');
    assert.equal(a.reasoning_signature, SIG);
  });
});

// The whole rescue path end to end: real rescue logic (streamChatWithEmptyRetry),
// real adapter, real /v1/messages stream translator; only the upstream is faked.
// The client must end up with an unsigned abandoned block and a signed final
// block, and replaying that history must send exactly the final block upstream.
describe('rescue retry: streamed history round-trips the final attempt signature', () => {
  const KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'DEVIN_CONNECT_REPLAY_SIGNED_THINKING',
    'WINDSURFAPI_STRICT_MODEL', 'DEVIN_CONNECT_RETRY_ON_EMPTY_MS'];
  const saved = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOKEN = TOKEN;
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = '1';
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    delete process.env.WINDSURF_API_KEY;
  });
  afterEach(() => {
    __setStreamChatForTest(null);
    __setConnectDeps(null);
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  function fakeRes() {
    return {
      body: '', writableEnded: false, headersSent: false,
      writeHead() { this.headersSent = true; return this; },
      setHeader() {}, flushHeaders() {},
      write(c) { this.body += String(c); return true; },
      end(c) { if (c) this.body += String(c); this.writableEnded = true; },
      on() { return this; }, once() { return this; }, off() { return this; }, removeListener() { return this; },
    };
  }
  function blocksFrom(raw) {
    const blocks = [];
    for (const frame of raw.split('\n\n')) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'content_block_start') blocks[ev.index] = { ...ev.content_block, _json: '' };
      if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index]; const d = ev.delta;
        if (d.type === 'thinking_delta') b.thinking += d.thinking;
        if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
        if (d.type === 'text_delta') b.text += d.text;
        if (d.type === 'input_json_delta') b._json += d.partial_json;
      }
    }
    return blocks.filter(Boolean).map(({ _json, ...b }) => (b.type === 'tool_use' ? { ...b, input: JSON.parse(_json || '{}') } : b));
  }

  it('abandoned attempt closes unsigned, final attempt is signed and is what gets replayed', async () => {
    let upstreamCalls = 0;
    __setStreamChatForTest(async function* () {
      upstreamCalls++;
      if (upstreamCalls === 1) {
        // thinking-only, no tool call: triggers the rescue
        yield { type: 'reasoning', text: 'abandoned attempt' };
        yield { type: 'signature', reasoning_signature: 'OLD-SIG' };
        yield { type: 'finish', reason: 'stop', usage: null };
        return;
      }
      yield { type: 'reasoning', text: 'final attempt' };
      yield { type: 'signature', reasoning_signature: 'NEW-SIG' };
      yield { type: 'finish', reason: 'tool_calls', usage: null, toolCalls: [{ id: 'toolu_r1', name: 'log_event', arguments: '{}' }] };
    });
    const tools = [{ name: 'log_event', description: 'log', input_schema: { type: 'object', properties: {} } }];
    const out = await handleMessages({ model: 'claude-opus-4.8', max_tokens: 64, stream: true, tools,
      messages: [{ role: 'user', content: 'go' }] }, { callerKey: 'rescue-test' });
    const res = fakeRes();
    await out.handler(res);
    assert.equal(upstreamCalls, 2, 'precondition: the rescue re-issued the request');

    const blocks = blocksFrom(res.body);
    const thinking = blocks.filter((b) => b.type === 'thinking');
    assert.deepEqual(thinking.map((b) => [b.thinking, b.signature || '']), [['abandoned attempt', ''], ['final attempt', 'NEW-SIG']]);
    assert.ok(blocks.some((b) => b.type === 'tool_use'), 'the final attempt tool call reached the client');

    let seen = null;
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen = params;
        return { status: 200, body: { id: 'x', object: 'chat.completion', created: 0, model: params.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
      },
    });
    const toolUse = blocks.find((b) => b.type === 'tool_use');
    await handleMessages({ model: 'claude-opus-4.8', max_tokens: 64, tools, messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: blocks },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'logged' }] },
    ] }, { callerKey: 'rescue-test' });
    const a = seen.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length);
    assert.equal(a.reasoning_content, 'final attempt');
    assert.equal(a.reasoning_signature, 'NEW-SIG');
  });
});

describe('/v1/messages stream translator: a reasoning break closes the open thinking block unsigned', () => {
  it('drops a signature already pending for the abandoned block', async () => {
    const chunk = (c) => `data: ${JSON.stringify(c)}\n\n`;
    const out = await handleMessages({ model: 'claude-opus-4.8', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }] }, {
      async handleChatCompletions() {
        return { status: 200, stream: true, async handler(res) {
          res.write(chunk({ choices: [{ index: 0, delta: { reasoning_content: 'abandoned' }, finish_reason: null }] }));
          res.write(chunk({ choices: [{ index: 0, delta: { reasoning_signature: 'STALE' }, finish_reason: null }] }));
          res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: null, _windsurf_reasoning_break: true }] }));
          res.write(chunk({ choices: [{ index: 0, delta: { reasoning_content: 'final' }, finish_reason: null }] }));
          res.write(chunk({ choices: [{ index: 0, delta: { reasoning_signature: 'FRESH' }, finish_reason: null }] }));
          res.write(chunk({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }));
          res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
          res.end('data: [DONE]\n\n');
        } };
      },
    });
    let body = '';
    await out.handler({ writableEnded: false, write(c) { body += String(c); return true; }, end(c) { if (c) body += String(c); this.writableEnded = true; }, on() { return this; } });
    const events = body.split('\n\n').map((f) => f.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
    const starts = events.filter((e) => e.type === 'content_block_start').map((e) => [e.index, e.content_block.type]);
    const sigs = events.filter((e) => e.delta?.type === 'signature_delta').map((e) => [e.index, e.delta.signature]);
    assert.deepEqual(starts, [[0, 'thinking'], [1, 'thinking'], [2, 'text']]);
    assert.deepEqual(sigs, [[1, 'FRESH']]);
  });
});

// Plain (no tool call) assistant turns. Opus 4.5+ keeps prior turns' thinking,
// and the upstream honors a replay after a later user message (measured
// 2026-10-28: recall 3/3 replayed vs 0/4 without, forced-answer design).
describe('signed thinking on a plain assistant turn', () => {
  it('wire: writes #11 thinking and #12 signature on the role=2 text frame', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', env: {},
      messages: [
        { role: 'user', content: 'invent a city' },
        { role: 'assistant', content: 'Saltmarrow', reasoning_content: 'population 312,847\n\n', reasoning_signature: SIG },
        { role: 'user', content: 'population?' },
      ],
    });
    const assistant = wireChats(proto).filter((c) => Number(getField(c, 2, 0).value) === __testing.SOURCE.ASSISTANT);
    assert.equal(assistant.length, 1);
    assert.equal(str(assistant[0], 3), 'Saltmarrow');
    assert.equal(str(assistant[0], 11), 'population 312,847\n\n', '#11 is verbatim, never trimmed');
    assert.equal(str(assistant[0], 12), SIG);
  });

  it('wire: no #12 without a signature, and the probe alone still writes only its #11', () => {
    const plain = buildGetChatMessageRequest({ token: TOKEN, model: 'm', env: {},
      messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a', reasoning_content: 'r' }, { role: 'user', content: 'u2' }] });
    for (const c of wireChats(plain)) { assert.equal(getField(c, 11, 2), null); assert.equal(getField(c, 12, 2), null); }
    const signedWithProbe = buildGetChatMessageRequest({ token: TOKEN, model: 'm', env: { DEVIN_CONNECT_REPLAY_REASONING: '1' },
      messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a', reasoning_content: 'r', reasoning_signature: SIG }, { role: 'user', content: 'u2' }] });
    const a = wireChats(signedWithProbe)[1];
    assert.equal(a.filter((f) => f.field === 11).length, 1);
    assert.equal(str(a, 12), SIG);
  });

  describe('/v1/messages end to end', () => {
    const KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'DEVIN_CONNECT_REPLAY_SIGNED_THINKING', 'WINDSURFAPI_STRICT_MODEL'];
    const saved = {};
    let seen = null;
    beforeEach(() => {
      for (const k of KEYS) saved[k] = process.env[k];
      process.env.DEVIN_CONNECT = '1';
      process.env.DEVIN_CONNECT_TOKEN = TOKEN;
      process.env.WINDSURFAPI_STRICT_MODEL = '0';
      delete process.env.WINDSURF_API_KEY;
      seen = null;
      __setConnectDeps({
        toChatCompletion: async (params) => {
          seen = params;
          return { status: 200, body: { id: 'x', object: 'chat.completion', created: 0, model: params.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
        },
      });
    });
    afterEach(() => {
      __setConnectDeps(null);
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    });
    const history = (sig) => ([
      { role: 'user', content: 'invent a city' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'population 312,847', signature: sig }, { type: 'text', text: 'Saltmarrow' }] },
      { role: 'user', content: 'population?' },
    ]);
    const textTurn = () => seen.messages.find((m) => m.role === 'assistant' && !m.tool_calls?.length);

    for (const withTools of [false, true]) {
      it(`reaches the connect adapter on a ${withTools ? 'tool-bearing' : 'tool-less'} request`, async () => {
        process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = '1';
        const tools = withTools ? [{ name: 'log_event', description: 'log', input_schema: { type: 'object', properties: {} } }] : undefined;
        await handleMessages({ model: 'claude-opus-4.8', max_tokens: 64, ...(tools ? { tools } : {}), messages: history(SIG) }, { callerKey: 'sig-text' });
        const a = textTurn();
        assert.equal(a.reasoning_content, 'population 312,847');
        assert.equal(a.reasoning_signature, SIG);
      });
    }

    it('stays off when the switch is off, and for an unsigned block', async () => {
      delete process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING;
      await handleMessages({ model: 'claude-opus-4.8', max_tokens: 64, messages: history(SIG) }, { callerKey: 'sig-text' });
      assert.equal(textTurn().reasoning_signature, undefined);
      process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = '1';
      await handleMessages({ model: 'claude-opus-4.8', max_tokens: 64, messages: history('') }, { callerKey: 'sig-text' });
      assert.equal(textTurn().reasoning_signature, undefined);
    });
  });
});

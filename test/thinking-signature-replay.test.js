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

  it('stream: each increment becomes a reasoning_signature delta', async () => {
    __setStreamChatForTest(fake(SIGNED));
    const frames = [];
    await streamChatCompletion({ model: 'm', messages: [] }, (d) => frames.push(d));
    const sigs = frames.flatMap((f) => f.choices || []).map((c) => c.delta?.reasoning_signature).filter(Boolean);
    assert.deepEqual(sigs, ['Ep', 'kC']);
  });

  // A real rescue: the first upstream attempt is thinking-only (no text, no tool
  // call) on a tool-bearing request, so streamChatWithEmptyRetry replaces it. The
  // abandoned attempt's reasoning AND signature must die with it; the client must
  // see only the final attempt, sealed by the final attempt's own signature.
  it('stream: a rescue drops the abandoned attempt signature together with its reasoning', async () => {
    const saved = process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS;
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let upstreamCalls = 0;
    __setStreamChatForTest(async function* () {
      upstreamCalls++;
      if (upstreamCalls === 1) {
        yield { type: 'reasoning', text: 'abandoned attempt' };
        yield { type: 'signature', reasoning_signature: 'OLD-SIG' };
        yield { type: 'finish', reason: 'stop', usage: null };
        return;
      }
      yield { type: 'reasoning', text: 'final attempt' };
      yield { type: 'signature', reasoning_signature: 'NEW-SIG' };
      yield { type: 'finish', reason: 'tool_calls', usage: null, toolCalls: [{ id: 'toolu_r1', name: 'log_event', arguments: '{}' }] };
    });
    try {
      const frames = [];
      const tools = [{ type: 'function', function: { name: 'log_event', parameters: { type: 'object', properties: {} } } }];
      await streamChatCompletion({ model: 'm', messages: [], tools }, (d) => frames.push(d));
      assert.equal(upstreamCalls, 2, 'precondition: the rescue re-issued the request');
      const order = frames.flatMap((f) => f.choices || [])
        .map((c) => (c.delta?.reasoning_signature ? `sig:${c.delta.reasoning_signature}` : c.delta?.reasoning_content ? `think:${c.delta.reasoning_content}` : c.delta?.tool_calls ? 'call' : null))
        .filter(Boolean);
      assert.deepEqual(order, ['think:final attempt', 'sig:NEW-SIG', 'call']);
    } finally {
      if (saved === undefined) delete process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS; else process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = saved;
    }
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

  it('when on, an unsigned or multi-block turn is not replayed', async () => {
    process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = '1';
    await handleMessages(body([{ type: 'thinking', thinking: 't', signature: '' }]), { callerKey: 'sig-test' });
    assert.equal(assistantWithCalls().reasoning_signature, undefined);
    await handleMessages(body([
      { type: 'thinking', thinking: 'a', signature: SIG },
      { type: 'thinking', thinking: 'b', signature: SIG },
    ]), { callerKey: 'sig-test' });
    assert.equal(assistantWithCalls().reasoning_signature, undefined);
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

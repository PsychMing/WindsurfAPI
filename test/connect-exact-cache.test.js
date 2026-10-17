// DEVIN_CONNECT exact-match cache: the outer slot must cover the stream path
// (the inner cascade cache is unreachable once the connect short-circuit fires)
// and must replay the stored finish reason instead of flattening it to 'stop'.
//
// These drive the real handler with the connect network calls mocked, so no
// token or socket is touched. The cache is process-global; every test clears it.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { cacheClear, cacheStats } from '../src/cache.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';

const CALLER = 'api:test:user:connect-cache';
const MODEL = 'swe-1-6-slow';
const created = [];
const saved = {};

function seed() {
  const a = addAccountByKey(`devin-session-token$cache-${Math.random().toString(36).slice(2)}`, 'cache-test');
  created.push(a.id);
  return a;
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
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseFrames(raw) {
  return raw.split('\n\n').filter(Boolean).filter(f => !f.startsWith(':')).map(f => {
    const data = f.split('\n').find(line => line.startsWith('data: '))?.slice(6) || '';
    return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
  });
}

function body(extra = {}) {
  return { model: MODEL, messages: [{ role: 'user', content: 'hi' }], __callerKey: CALLER, ...extra };
}

function nonStream(content, finishReason = 'stop', extraMessage = {}) {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-cache-test', object: 'chat.completion', created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content, ...extraMessage }, finish_reason: finishReason }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  };
}

beforeEach(() => {
  saved.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
  process.env.DEVIN_CONNECT = '1';
  cacheClear();
  seed();
});

afterEach(() => {
  __resetConnectDeps();
  cacheClear();
  while (created.length) removeAccount(created.pop());
  if (saved.DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = saved.DEVIN_CONNECT;
});

describe('DEVIN_CONNECT exact cache', () => {
  it('serves a repeated non-stream request without calling upstream and keeps finish_reason=length', async () => {
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => { calls++; return nonStream('cached answer', 'length'); },
    });

    const first = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(first.status, 200);
    assert.equal(calls, 1);

    const second = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(calls, 1, 'the second request must be served from the cache');
    assert.equal(second.status, 200);
    assert.equal(second.body.choices[0].message.content, 'cached answer');
    assert.equal(second.body.choices[0].finish_reason, 'length',
      'a cached truncation must not be replayed as a clean stop');
    assert.ok(cacheStats().hits >= 1);
  });

  it('serves a repeated stream request without calling upstream and keeps finish_reason=length', async () => {
    let calls = 0;
    __setConnectDeps({
      streamChatCompletion: async () => {
        calls++;
        return { content: 'streamed answer', reasoning: '', finish_reason: 'length',
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, toolCalls: [] };
      },
    });

    const first = await handleChatCompletions(body({ stream: true, stream_options: { include_usage: true } }), { callerKey: CALLER });
    assert.equal(first.status, 200);
    await first.handler(fakeRes());
    assert.equal(calls, 1);

    const second = await handleChatCompletions(body({ stream: true, stream_options: { include_usage: true } }), { callerKey: CALLER });
    const res = fakeRes();
    await second.handler(res);
    assert.equal(calls, 1, 'the second stream must be served from the cache');

    const frames = parseFrames(res.body);
    const finish = frames.find(frame => frame.choices?.[0]?.finish_reason);
    assert.ok(finish, 'a finish chunk must be emitted');
    assert.equal(finish.choices[0].finish_reason, 'length');
    assert.equal(frames.at(-1), '[DONE]');
  });

  it('does not cache tool-call turns', async () => {
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => {
        calls++;
        return nonStream(null, 'tool_calls', {
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
        });
      },
    });

    const first = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(first.status, 200);
    const second = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(second.status, 200);
    assert.equal(calls, 2, 'a tool-call turn must not populate the text cache');
  });

  it('does not cache without a trustworthy per-user scope', async () => {
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => { calls++; return nonStream('uncached'); },
    });
    const unscoped = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] };

    await handleChatCompletions(unscoped, { callerKey: '' });
    await handleChatCompletions(unscoped, { callerKey: '' });
    assert.equal(calls, 2, 'a bare API key must not share a response-cache slot');
  });

  it('replays the stored stop sequence for the internal Messages carrier', async () => {
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => { calls++; return nonStream('hello END world', 'stop'); },
    });

    const request = body({ stop: ['END'] });
    const first = await handleChatCompletions(request, { callerKey: CALLER });
    assert.equal(first.status, 200);
    assert.equal(calls, 1);

    const second = await handleChatCompletions(request, { callerKey: CALLER, __messagesStopCarrier: true });
    assert.equal(calls, 1);
    assert.equal(second.body.choices[0].message.content, 'hello ');
    assert.equal(second.body.choices[0]._windsurf_stop_sequence, 'END',
      'the carrier must survive the cache replay, not just the live turn');
  });

  it('replays the stored stop sequence on the stream carrier too', async () => {
    let calls = 0;
    __setConnectDeps({
      streamChatCompletion: async () => {
        calls++;
        return { content: 'hello END world', reasoning: '', finish_reason: 'stop',
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, toolCalls: [] };
      },
    });

    const request = body({ stream: true, stop: ['END'] });
    const first = await handleChatCompletions(request, { callerKey: CALLER });
    await first.handler(fakeRes());
    assert.equal(calls, 1);

    const second = await handleChatCompletions(request, { callerKey: CALLER, __messagesStopCarrier: true });
    const res = fakeRes();
    await second.handler(res);
    assert.equal(calls, 1);
    const finish = parseFrames(res.body).find(frame => frame.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0]._windsurf_stop_sequence, 'END');
  });
});

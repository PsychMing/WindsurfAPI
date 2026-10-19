import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';
import { __resetRequestRingForTest, listRequests } from '../src/dashboard/request-ring.js';

// Q2 gap: protocol translation had unit coverage, but no startServer HTTP
// success test for Messages, Gemini, or Responses, and no full tool loop.
// These are harness-shaped requests, not one-word probes.
const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
for (const key of ENV_KEYS) SAVED[key] = process.env[key];

let server;
let port;
let lastParams = null;
let streamBehavior = 'text';

function completion(message, finish = 'stop') {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-harness',
      object: 'chat.completion',
      created: 0,
      model: 'claude-haiku-5-5-low',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  };
}

before(async () => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  config.apiKey = 'test-harness-key';
  config.host = '127.0.0.1';
  config.port = 0;
  __setConnectDeps({
    toChatCompletion: async (params) => {
      lastParams = params;
      if (Array.isArray(params.messages) && params.messages.some((m) => m?.role === 'tool')) {
        return completion({ role: 'assistant', content: '22' });
      }
      return completion({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_harness_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        }],
      }, 'tool_calls');
    },
    streamChatCompletion: async (_params, send) => {
      if (streamBehavior === 'tool') {
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_harness_1', type: 'function', function: { name: 'get_', arguments: '{"city":' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'weather', arguments: '"Tokyo"}' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        return { content: '', reasoning: '', toolCalls: [{ id: 'call_harness_1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
      }
      send({
        id: 'chatcmpl-harness',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'claude-haiku-5-5-low',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' }, finish_reason: null }],
      });
      send({
        id: 'chatcmpl-harness',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'claude-haiku-5-5-low',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      return { content: 'PONG', reasoning: '', toolCalls: [], finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    },
  });
  server = startServer();
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  port = server.address().port;
});

after(async () => {
  __resetConnectDeps();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

function post(path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-harness-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('startServer harness-shaped success paths', () => {
  it('runs a chat tool_call -> tool result -> final answer loop through the real router', async () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }];
    const first = await post('/v1/chat/completions', {
      model: 'claude-haiku-5-5-low',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      tools,
      tool_choice: 'auto',
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    assert.equal(firstBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, 'get_weather');
    assert.equal(firstBody.choices?.[0]?.finish_reason, 'tool_calls');

    const second = await post('/v1/chat/completions', {
      model: 'claude-haiku-5-5-low',
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        { role: 'assistant', content: null, tool_calls: firstBody.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: 'call_harness_1', content: '{"temperature":22,"city":"Tokyo"}' },
        { role: 'user', content: 'What is the temperature? Reply with just the number.' },
      ],
      tools,
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.equal(secondBody.choices?.[0]?.message?.content, '22');
    assert.ok(lastParams, 'upstream received the second turn');
    assert.match(JSON.stringify(lastParams.messages), /temperature/);
  });

  it('forwards a 600 KB harness history through the real router', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'claude-haiku-5-5-low',
      messages: [
        { role: 'system', content: 'You are a coding agent. '.repeat(100) },
        { role: 'user', content: 'x'.repeat(600000) },
      ],
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(lastParams, 'upstream received the long request');
    const size = JSON.stringify(lastParams.messages).length;
    assert.ok(size > 500000, `upstream history was unexpectedly small: ${size}`);
  });

  it('serves Anthropic Messages success through the real router', async () => {
    const res = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    assert.match(body, /message_start/);
    assert.match(body, /PONG/);
  });

  it('serves Responses success through the real router', async () => {
    const res = await post('/v1/responses', {
      model: 'claude-haiku-5-5-low',
      stream: true,
      store: false,
      input: 'Reply with exactly: PONG',
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    assert.match(body, /response\.output_text\.delta/);
    assert.match(body, /PONG/);
  });

  it('streams split tool-call deltas through Anthropic Messages', async () => {
    streamBehavior = 'tool';
    try {
      const res = await post('/v1/messages', {
        model: 'claude-haiku-5-5-low',
        max_tokens: 64,
        stream: true,
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      });
      const body = await res.text();
      assert.equal(res.status, 200, body);
      const starts = body.split('\n\n').filter((frame) => frame.includes('content_block_start'));
      const toolStart = starts.find((frame) => frame.includes('tool_use'));
      assert.ok(toolStart, body);
      assert.match(toolStart, /get_weather/);
      const deltas = body.split('\n\n').filter((frame) => frame.includes('input_json_delta'));
      const json = deltas.map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)).delta.partial_json).join('');
      assert.deepEqual(JSON.parse(json), { city: 'Tokyo' });
      assert.match(body, /"stop_reason":"tool_use"/);
    } finally {
      streamBehavior = 'text';
    }
  });

  it('records Messages and Gemini rows in the request ring with protocol', async () => {
    __resetRequestRingForTest();
    const messages = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    assert.equal(messages.status, 200);
    await messages.text();
    const gemini = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    });
    assert.equal(gemini.status, 200);
    await gemini.text();
    const rows = listRequests({ limit: 20 }).items;
    const protocols = rows.map((row) => row.protocol);
    assert.ok(protocols.includes('messages'), JSON.stringify(protocols));
    assert.ok(protocols.includes('gemini'), JSON.stringify(protocols));
  });

  it('serves Gemini SSE and default array success through the real router', async () => {
    const req = {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    };
    const sse = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', req);
    const sseBody = await sse.text();
    assert.equal(sse.status, 200, sseBody);
    assert.match(sseBody, /data:/);
    assert.match(sseBody, /PONG/);

    const array = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent', req);
    const arrayBody = await array.text();
    assert.equal(array.status, 200, arrayBody);
    const parsed = JSON.parse(arrayBody);
    assert.ok(Array.isArray(parsed), 'default Gemini stream is a JSON array');
    assert.match(arrayBody, /PONG/);
  });
});

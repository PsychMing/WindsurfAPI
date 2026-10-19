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
let nonStreamBehavior = 'tool';

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
      if (nonStreamBehavior === 'text') return completion({ role: 'assistant', content: 'PONG' });
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
      if (streamBehavior === 'parallel') {
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        return { content: '', reasoning: '', toolCalls: [
          { id: 'call_a', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          { id: 'call_b', name: 'get_time', arguments: '{"zone":"UTC"}' },
        ], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
      }
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

function sseData(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean)
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data) => data && data.trim() !== '[DONE]')
    .map((data) => JSON.parse(data));
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

  it('serves non-stream success for Messages, Responses, and Gemini', async () => {
    nonStreamBehavior = 'text';
    try {
    const messages = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low', max_tokens: 16, stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    const messagesBody = await messages.json();
    assert.equal(messages.status, 200, JSON.stringify(messagesBody));
    assert.equal(messagesBody.content?.[0]?.type, 'text');
    assert.match(messagesBody.content?.[0]?.text || '', /PONG/);

    const responses = await post('/v1/responses', {
      model: 'claude-haiku-5-5-low', stream: false, store: false,
      input: 'Reply with exactly: PONG',
    });
    const responsesBody = await responses.json();
    assert.equal(responses.status, 200, JSON.stringify(responsesBody));
    assert.match(JSON.stringify(responsesBody.output), /PONG/);

    const gemini = await post('/v1beta/models/claude-haiku-5-5-low:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    });
    const geminiBody = await gemini.json();
    assert.equal(gemini.status, 200, JSON.stringify(geminiBody));
    assert.match(JSON.stringify(geminiBody.candidates), /PONG/);
    } finally {
      nonStreamBehavior = 'tool';
    }
  });

  it('runs a Responses function_call -> function_call_output -> final answer loop', async () => {
    const tools = [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
    const first = await post('/v1/responses', {
      model: 'claude-haiku-5-5-low', stream: false, store: false,
      input: 'What is the weather in Tokyo?', tools,
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    const call = firstBody.output?.find((item) => item.type === 'function_call');
    assert.ok(call, JSON.stringify(firstBody));
    assert.equal(call.name, 'get_weather');

    const second = await post('/v1/responses', {
      model: 'claude-haiku-5-5-low', stream: false, store: false,
      input: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: '{"temperature":22}' },
        { role: 'user', content: 'Reply with just the number.' },
      ],
      tools,
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.match(JSON.stringify(secondBody.output), /22/);
    assert.match(JSON.stringify(lastParams.messages), /temperature/);
  });

  it('runs a Messages tool_use -> tool_result -> final answer loop', async () => {
    const tools = [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];
    const first = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low', max_tokens: 64, stream: false,
      tools, messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    const call = firstBody.content?.find((block) => block.type === 'tool_use');
    assert.ok(call, JSON.stringify(firstBody));
    assert.equal(call.name, 'get_weather');

    const second = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low', max_tokens: 64, stream: false, tools,
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: '{"temperature":22}' }] },
        { role: 'user', content: 'Reply with just the number.' },
      ],
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.match(JSON.stringify(secondBody.content), /22/);
    assert.match(JSON.stringify(lastParams.messages), /temperature/);
  });

  it('runs a Gemini functionCall -> functionResponse -> final answer loop', async () => {
    const tools = [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }] }];
    const first = await post('/v1beta/models/claude-haiku-5-5-low:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] }], tools,
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    const call = firstBody.candidates?.[0]?.content?.parts?.find((part) => part.functionCall)?.functionCall;
    assert.ok(call, JSON.stringify(firstBody));
    assert.equal(call.name, 'get_weather');

    const second = await post('/v1beta/models/claude-haiku-5-5-low:generateContent', {
      contents: [
        { role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] },
        { role: 'model', parts: [{ functionCall: { name: call.name, args: call.args } }] },
        { role: 'user', parts: [{ functionResponse: { name: call.name, response: { temperature: 22 } } }] },
        { role: 'user', parts: [{ text: 'Reply with just the number.' }] },
      ], tools,
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.match(JSON.stringify(secondBody.candidates), /22/);
    assert.match(JSON.stringify(lastParams.messages), /temperature/);
  });

  it('settles split tool names in the Gemini stream', async () => {
    streamBehavior = 'tool';
    try {
      const gemini = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
        contents: [{ role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] }],
        tools: [{ functionDeclarations: [{ name: 'get_weather' }] }],
      });
      const geminiBody = await gemini.text();
      assert.equal(gemini.status, 200, geminiBody);
      const call = sseData(geminiBody)
        .flatMap((frame) => frame.candidates?.[0]?.content?.parts || [])
        .find((part) => part.functionCall)?.functionCall;
      assert.equal(call?.name, 'get_weather', geminiBody);
    } finally {
      streamBehavior = 'text';
    }
  });

  it('keeps parallel tool calls distinct in Responses and Gemini streams', async () => {
    streamBehavior = 'parallel';
    try {
      const responses = await post('/v1/responses', {
        model: 'claude-haiku-5-5-low', stream: true, store: false, input: 'Use both tools',
        tools: [
          { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
          { type: 'function', name: 'get_time', parameters: { type: 'object' } },
        ],
      });
      const responsesBody = await responses.text();
      assert.equal(responses.status, 200, responsesBody);
      const responseCalls = sseData(responsesBody)
        .filter((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call')
        .map((e) => e.item.name);
      assert.deepEqual(responseCalls, ['get_weather', 'get_time'], responsesBody);

      const gemini = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
        contents: [{ role: 'user', parts: [{ text: 'Use both tools' }] }],
        tools: [{ functionDeclarations: [{ name: 'get_weather' }, { name: 'get_time' }] }],
      });
      const geminiBody = await gemini.text();
      assert.equal(gemini.status, 200, geminiBody);
      const geminiCalls = sseData(geminiBody)
        .flatMap((frame) => frame.candidates?.[0]?.content?.parts || [])
        .filter((part) => part.functionCall)
        .map((part) => part.functionCall.name);
      assert.deepEqual(geminiCalls, ['get_weather', 'get_time'], geminiBody);
    } finally {
      streamBehavior = 'text';
    }
  });

});

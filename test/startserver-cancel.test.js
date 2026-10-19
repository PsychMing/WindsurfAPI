import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';

const SAVED = {};
for (const key of ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY']) SAVED[key] = process.env[key];

let server;
let port;
let calls = 0;
let aborted = false;
let abortResolve;
const abortSeen = new Promise((resolve) => { abortResolve = resolve; });

before(async () => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  config.apiKey = 'test-cancel-key';
  config.host = '127.0.0.1';
  config.port = 0;
  __setConnectDeps({
    streamChatCompletion: async (params, send) => {
      calls += 1;
      send({
        id: 'chatcmpl-cancel', object: 'chat.completion.chunk', created: 0,
        model: 'claude-haiku-5-5-low',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'first' }, finish_reason: null }],
      });
      await new Promise((_, reject) => {
        const fail = () => {
          aborted = true;
          abortResolve();
          reject(Object.assign(new Error('client disconnected'), { name: 'AbortError' }));
        };
        if (params.signal?.aborted) fail();
        else params.signal?.addEventListener('abort', fail, { once: true });
      });
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
  for (const key of Object.keys(SAVED)) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

describe('real-socket cancellation', () => {
  it('aborts the upstream once and keeps the server healthy', async () => {
    const body = JSON.stringify({
      model: 'claude-haiku-5-5-low', max_tokens: 16, stream: true,
      messages: [{ role: 'user', content: 'hold the stream' }],
    });
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: {
          authorization: 'Bearer test-cancel-key',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        assert.equal(res.statusCode, 200);
        res.once('data', () => {
          req.destroy();
          resolve();
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end(body);
    });
    await Promise.race([
      abortSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not aborted')), 1500)),
    ]);
    assert.equal(aborted, true);
    assert.equal(calls, 1, 'client cancellation must not replay or fail over');
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    await health.text();
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serveChatStream } from '../src/server.js';

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    flushHeaders() { this.headersSent = true; },
    setHeader() {}, getHeader() {}, removeHeader() {},
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true; },
    on() {}, once() {}, removeListener() {}, destroy() { this.writableEnded = true; },
  };
}

const errorFrame = 'data: {"error":{"message":"busy","code":"RATE_LIMITED","retry_after_ms":2500}}\n\n';
const contentFrame = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';

describe('serveChatStream route wiring', () => {
  it('commitMs=0 restores the legacy raw-res shape', async () => {
    const res = fakeRes();
    let sawRaw = false;
    let done = 0;
    await serveChatStream(res, {
      status: 200,
      async handler(target) {
        sawRaw = target === res;
        target.write(errorFrame);
        target.end();
      },
    }, { headers: { 'content-type': 'text/event-stream' }, requestId: 'r1', commitMs: 0, onDone: () => { done += 1; } });
    assert.equal(sawRaw, true);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /RATE_LIMITED/);
    assert.equal(done, 1);
  });

  it('gates a pre-content error into a real 429', async () => {
    const res = fakeRes();
    await serveChatStream(res, {
      status: 200,
      async handler(target) { target.write(errorFrame); target.end(); },
    }, { headers: { 'content-type': 'text/event-stream' }, requestId: 'r1', commitMs: undefined });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '30');
    assert.equal(res.body.startsWith('{"error"'), true);
  });

  it('commits a content frame as SSE 200', async () => {
    const res = fakeRes();
    await serveChatStream(res, {
      status: 200,
      async handler(target) { target.write(contentFrame); target.end(); },
    }, { headers: { 'content-type': 'text/event-stream' }, requestId: 'r1', commitMs: undefined });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /hi/);
  });

  it('closes a committed socket when the handler throws', async () => {
    const res = fakeRes();
    await assert.rejects(serveChatStream(res, {
      status: 200,
      async handler(target) { target.write(contentFrame); throw new Error('boom'); },
    }, { headers: {}, requestId: 'r1', commitMs: undefined }), /boom/);
    assert.equal(res.writableEnded, true);
  });
});

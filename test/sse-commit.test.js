import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDeferredSseResponse } from '../src/sse-commit.js';

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; },
    end(chunk) { if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); this.writableEnded = true; },
    setHeader() {},
    getHeader() {},
    removeHeader() {},
    on() {},
    once() {},
    removeListener() {},
    destroy() { this.writableEnded = true; },
    socket: null,
  };
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe('createDeferredSseResponse', () => {
  it('commits a normal content frame as SSE 200 with byte-identical body', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const body = frame({ choices: [{ delta: { content: 'hi' } }] });
    res.write(body);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.headers['content-type'], 'text/event-stream');
    assert.equal(real.body, body);
  });

  it('holds a role-only prime until a real payload arrives', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    const role = frame({ choices: [{ delta: { role: 'assistant' } }] });
    const content = frame({ choices: [{ delta: { content: 'hi' } }] });
    res.write(role);
    assert.equal(real.statusCode, null, 'role-only frame must not commit');
    res.write(content);
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, role + content);
  });

  it('turns a pre-content error frame into a JSON 429 with Retry-After', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' },
      requestId: 'req_1',
    });
    res.write(frame({
      error: {
        message: 'rate limited',
        type: 'rate_limit_error',
        code: 'RATE_LIMITED',
        retry_after_ms: 2500,
      },
    }));
    res.end();
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(real.headers['retry-after'], '30');
    const body = JSON.parse(real.body);
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(body.request_id, 'req_1');
  });

  it('maps a multi-line CRLF error frame without cutting it at the first line', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write('data: {"error":\r\ndata: {"message":"busy","code":"RATE_LIMITED","retry_after_ms":2500}}\r\n\r\n');
    res.end();
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], '30');
  });

  it('does not rewrite an error that arrives after content committed', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    const content = frame({ choices: [{ delta: { content: 'partial' } }] });
    const error = frame({ error: { message: 'died', code: 'UPSTREAM_ERROR' } });
    res.write(content);
    res.write(error);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, content + error);
  });

  it('holds heartbeats until a real frame arrives', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write(': ping\n\n');
    assert.equal(real.statusCode, null);
    res.write(frame({ choices: [{ delta: { content: 'hi' } }] }));
    assert.equal(real.statusCode, 200);
    assert.equal(real.body.startsWith(': ping\n\n'), true);
  });

  it('commits after the bootstrap frame cap instead of buffering forever', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, maxFrames: 3 });
    res.write(': ping\n\n');
    res.write(': ping\n\n');
    res.write(': ping\n\n');
    assert.equal(real.statusCode, null, 'three bootstrap frames are still held');
    res.write(': ping\n\n');
    assert.equal(real.statusCode, 200, 'fourth bootstrap frame commits');
  });
});

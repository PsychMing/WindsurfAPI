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

  it('maps classified error codes to the documented statuses', () => {
    for (const [code, status] of [['MODEL_BLOCKED', 402], ['QUOTA_EXHAUSTED', 402], ['UPSTREAM_INTERNAL', 503], ['NO_TOKEN', 401], ['RATE_LIMITED', 429], ['windsurf_provider_deadline', 504]]) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200 });
      res.write(`data: ${JSON.stringify({ error: { message: code, code } })}\n\n`);
      res.end();
      assert.equal(real.statusCode, status, code);
    }
  });

  it('derives the official body type from the classified code', () => {
    for (const [code, type] of [['MODEL_BLOCKED', 'permission_error'], ['QUOTA_EXHAUSTED', 'insufficient_quota'], ['UNAUTHORIZED', 'authentication_error'], ['CONTENT_BLOCKED', 'invalid_request_error']]) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200 });
      res.write(`data: ${JSON.stringify({ error: { message: code, code } })}\n\n`);
      res.end();
      assert.equal(JSON.parse(real.body).error.type, type, code);
    }
  });

  it('recognizes an error frame without a space after data:', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write('data:{"error":{"message":"busy","code":"RATE_LIMITED"}}\n\n');
    res.end();
    assert.equal(real.statusCode, 429);
  });

  it('commits a function_call-first frame instead of holding it', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write(frame({ choices: [{ delta: { function_call: { name: 'f', arguments: '{}' } } }] }));
    assert.equal(real.statusCode, 200);
  });

  it('commits a reasoning-first frame as SSE instead of treating it as a bootstrap', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write(frame({ choices: [{ delta: { reasoning_content: 'think' } }] }));
    assert.equal(real.statusCode, 200);
    res.write(frame({ error: { message: 'late', code: 'RATE_LIMITED' } }));
    res.end();
    assert.equal(real.statusCode, 200, 'a post-content error must not rewrite the status');
    assert.match(real.body, /think/);
  });

  it('flushes headers on an empty commit', () => {
    let flushed = 0;
    const real = fakeRes();
    real.flushHeaders = () => { flushed += 1; };
    const res = createDeferredSseResponse(real, { status: 200 });
    res.flushHeaders();
    assert.equal(real.statusCode, 200);
    assert.equal(flushed, 1);
  });

  it('dispose cancels a pending bootstrap timer without committing', async () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, bootstrapTimeoutMs: 10 });
    res.dispose();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(real.statusCode, null);
    assert.equal(res.write('data: x\n\n'), false);
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

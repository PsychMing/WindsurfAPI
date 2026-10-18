import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SseFramer, findFrameEnd } from '../src/sse-framer.js';
import { createDeferredSseResponse } from '../src/sse-commit.js';

function collect(options = {}) {
  const frames = [];
  const comments = [];
  const framer = new SseFramer({
    ...options,
    onFrame: (f) => frames.push(f),
    onComment: (c) => comments.push(c),
  });
  return { framer, frames, comments };
}

describe('SseFramer', () => {
  it('parses canonical LF frames', () => {
    const { framer, frames } = collect();
    framer.push('event: message\ndata: {"a":1}\n\n');
    assert.deepEqual(frames, [{ event: 'message', data: '{"a":1}' }]);
  });

  it('parses CRLF frames', () => {
    const { framer, frames } = collect();
    framer.push('event: message\r\ndata: {"a":1}\r\n\r\n');
    assert.deepEqual(frames, [{ event: 'message', data: '{"a":1}' }]);
  });

  it('joins multi-line data with a newline', () => {
    const { framer, frames } = collect();
    framer.push('data: line1\ndata: line2\n\n');
    assert.deepEqual(frames, [{ event: null, data: 'line1\nline2' }]);
  });

  it('flushes a final frame at EOF without a blank line', () => {
    const { framer, frames } = collect();
    framer.push('data: tail');
    framer.end();
    assert.deepEqual(frames, [{ event: null, data: 'tail' }]);
  });

  it('preserves a multi-byte character split across Buffer chunks', () => {
    const { framer, frames } = collect();
    const bytes = Buffer.from('data: 你\n\n');
    framer.push(bytes.subarray(0, 7));
    framer.push(bytes.subarray(7));
    assert.deepEqual(frames, [{ event: null, data: '你' }]);
  });

  it('surfaces comments separately', () => {
    const { framer, comments } = collect();
    framer.push(': ping\n\n');
    assert.deepEqual(comments, [': ping']);
  });

  it('fails closed at the byte cap', () => {
    let overflow = null;
    const { framer } = collect({ maxFrameBytes: 8, onOverflow: (e) => { overflow = e; } });
    framer.push('data: 1234567890\n\n');
    assert.equal(framer.failed, true);
    assert.equal(overflow.code, 'SSE_FRAME_TOO_LARGE');
  });

  it('does not reject a batch of complete frames just because the push is large', () => {
    let overflow = null;
    const { framer, frames } = collect({ maxFrameBytes: 8, onOverflow: (e) => { overflow = e; } });
    framer.push('data: 1\n\ndata: 2\n\n');
    assert.equal(framer.failed, false);
    assert.equal(overflow, null);
    assert.deepEqual(frames, [{ event: null, data: '1' }, { event: null, data: '2' }]);
  });

  it('applies the cap to the frame payload, not the wire prefix', () => {
    let overflow = null;
    const { framer, frames } = collect({ maxFrameBytes: 10, onOverflow: (e) => { overflow = e; } });
    framer.push('data: 1234567890\n\n');
    assert.equal(framer.failed, false);
    assert.equal(overflow, null);
    assert.deepEqual(frames, [{ event: null, data: '1234567890' }]);
  });

  it('holds a trailing CR when the next chunk starts with LF', () => {
    const { framer, frames } = collect();
    framer.push('event: m\r');
    framer.push('\ndata: a\r\ndata: b\r\n\r\n');
    assert.deepEqual(frames, [{ event: 'm', data: 'a\nb' }]);
  });

  it('does not dispatch after end', () => {
    const { framer, frames } = collect();
    framer.push('data: one\n\n');
    framer.end();
    framer.push('data: two\n\n');
    assert.deepEqual(frames, [{ event: null, data: 'one' }]);
  });

  it('findFrameEnd recognizes LF and CRLF boundaries', () => {
    assert.deepEqual(findFrameEnd('a\n\nb'), { frameEnd: 1, next: 3 });
    assert.deepEqual(findFrameEnd('a\r\n\r\nb'), { frameEnd: 1, next: 5 });
    assert.equal(findFrameEnd('a\nb'), null);
  });

  it('findFrameEnd recognizes mixed line terminators', () => {
    assert.deepEqual(findFrameEnd('a\n\r\nb'), { frameEnd: 1, next: 4 });
    assert.deepEqual(findFrameEnd('a\r\n\rb'), { frameEnd: 1, next: 4 });
    assert.deepEqual(findFrameEnd('a\r\n\nb'), { frameEnd: 1, next: 4 });
    assert.deepEqual(findFrameEnd('a\n\rb'), { frameEnd: 1, next: 3 });
  });

  it('does not treat one lone CRLF as a frame boundary', () => {
    assert.equal(findFrameEnd('data: a\r\n'), null);
    assert.equal(findFrameEnd('data: a\r\nb'), null);
    assert.equal(findFrameEnd('data: a\n'), null);
    assert.equal(findFrameEnd('data: a\r'), null);
  });
});

describe('sse-commit + CRLF', () => {
  it('turns a CRLF error frame into a JSON 429', () => {
    const real = {
      statusCode: null, headers: null, body: '', writableEnded: false,
      writeHead(s, h) { this.statusCode = s; this.headers = h; },
      write(c) { this.body += String(c); return true; },
      end(c) { if (c) this.body += String(c); this.writableEnded = true; },
      setHeader() {}, getHeader() {}, removeHeader() {}, on() {}, once() {}, removeListener() {}, destroy() {},
    };
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write('data: {"error":{"message":"busy","code":"RATE_LIMITED","retry_after_ms":2500}}\r\n\r\n');
    res.end();
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], '30');
  });
});

// Shared SSE framer: one line-terminator rule for the three translators and the
// downstream commit gate. No dependencies.
//
// The canonical producer (chat.js) writes whole `data: <json>\n\n` strings, so the
// happy path is byte-identical. The framer hardens the seam against CRLF, split
// UTF-8, multi-line data, EOF without a blank line, and an unbounded buffer.

import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

const TERMINATOR_RE = /(\r\n\r\n|\n\n|\r\r)/g;
const LINE_RE = /(\r\n|\n|\r)/g;
const FIELD_RE = /^(event|data|id|retry):[ \t]?(.*)$/;

export function findFrameEnd(text, from = 0) {
  TERMINATOR_RE.lastIndex = from;
  const match = TERMINATOR_RE.exec(text);
  if (!match) return null;
  return { frameEnd: match.index, next: match.index + match[0].length };
}

export class SseFramer {
  constructor({
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    onFrame,
    onComment,
    onOverflow,
  } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.onFrame = onFrame;
    this.onComment = onComment;
    this.onOverflow = onOverflow;
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
    this.event = null;
    this.data = [];
    this.failed = false;
  }

  get bufferedBytes() {
    return Buffer.byteLength(this.buf, 'utf8') + Buffer.byteLength(this.data.join('\n'), 'utf8');
  }

  push(chunk) {
    if (this.failed) return;
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk));
    this.buf += text;
    if (this.bufferedBytes > this.maxFrameBytes) {
      this.#overflow();
      return;
    }
    this.#drain(false);
  }

  end() {
    if (this.failed) return;
    this.buf += this.decoder.end();
    this.#drain(true);
  }

  #drain(eof) {
    let offset = 0;
    for (;;) {
      LINE_RE.lastIndex = offset;
      const match = LINE_RE.exec(this.buf);
      if (!match) break;
      const line = this.buf.slice(offset, match.index);
      offset = match.index + match[0].length;
      this.#line(line);
    }
    this.buf = this.buf.slice(offset);
    if (eof) {
      if (this.buf.length) this.#line(this.buf);
      this.buf = '';
      this.#dispatch();
    }
    if (this.bufferedBytes > this.maxFrameBytes) this.#overflow();
  }

  #overflow() {
    if (this.failed) return;
    this.failed = true;
    this.onOverflow?.(Object.assign(new Error('SSE frame exceeds cap'), { code: 'SSE_FRAME_TOO_LARGE' }));
  }

  #line(line) {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.startsWith(':')) {
      this.onComment?.(line);
      return;
    }
    const match = FIELD_RE.exec(line);
    if (!match) return;
    if (match[1] === 'event') this.event = match[2];
    else if (match[1] === 'data') this.data.push(match[2]);
  }

  #dispatch() {
    if (this.event !== null || this.data.length) {
      this.onFrame?.({ event: this.event, data: this.data.join('\n') });
    }
    this.event = null;
    this.data = [];
  }
}

// Deferred SSE commit point.
//
// Why: the proxy currently writes HTTP 200 before the upstream attempt, so a
// pre-content 429/500 can only be delivered as an in-band SSE error frame after
// a 200. That loses the status and Retry-After. This wrapper holds the first
// frames until it can tell a real payload from an error, then either commits the
// SSE response or replaces it with a JSON error carrying the real status.
//
// It is deliberately protocol-agnostic at the byte level; the caller supplies
// the error-body shape. The first integration is the OpenAI chat route.

import { Buffer } from 'node:buffer';
import { findFrameEnd } from './sse-framer.js';
import { connectErrorToHttp, normalizeOpenAIErrorType, clientRetryAfterSeconds } from './handlers/chat.js';

const DEFAULT_MAX_FRAMES = 48;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_BOOTSTRAP_MS = 5_000;
const MAX_BOOTSTRAP_MS = 14_000;

function isCommentFrame(frame) {
  return frame.startsWith(':');
}

function dataPayload(frame) {
  const lines = frame.split('\n');
  const data = [];
  for (const line of lines) {
    if (line.startsWith('data: ')) data.push(line.slice(6));
    else if (line === 'data:') data.push('');
  }
  return data.join('\n');
}

function parseFrameJson(frame) {
  try {
    return JSON.parse(dataPayload(frame));
  } catch {
    return null;
  }
}

function isBootstrapFrame(frame, protocol) {
  if (isCommentFrame(frame)) return true;
  const obj = parseFrameJson(frame);
  if (!obj) return false;
  if (protocol === 'openai') {
    // Role-only prime chunk: no content, no tool call, no finish. Holding it is
    // safe because a client cannot observe anything from it alone.
    if (Array.isArray(obj.choices) && obj.choices.length > 0) {
      return obj.choices.every((c) => !c?.delta?.content && !c?.delta?.reasoning && !c?.delta?.reasoning_content && !c?.delta?.tool_calls && !c?.finish_reason);
    }
  }
  return false;
}

function errorFromFrame(frame) {
  const obj = parseFrameJson(frame);
  if (!obj || !obj.error || typeof obj.error !== 'object') return null;
  return obj.error;
}

function mapStatus(error, mapError) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  if (typeof mapError === 'function') return mapError(error).status;
  return connectErrorToHttp(error?.code).status;
}

function retryAfterSeconds(error) {
  const ms = Number(error?.retry_after_ms ?? error?.retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return clientRetryAfterSeconds(ms);
  return null;
}

export function createDeferredSseResponse(realRes, {
  status = 200,
  headers = {},
  protocol = 'openai',
  requestId = null,
  errorBody = null,
  mapError = null,
  maxFrames = DEFAULT_MAX_FRAMES,
  maxBytes = DEFAULT_MAX_BYTES,
  bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_MS,
} = {}) {
  const bootstrapMs = Math.max(0, Math.min(Number(bootstrapTimeoutMs) || 0, MAX_BOOTSTRAP_MS));
  let committed = false;
  let ended = false;
  let headerStatus = status;
  let headerObj = { ...headers };
  let pending = [];
  let pendingBytes = 0;
  let pendingFrames = 0;
  let inspectedChars = 0;
  let timer = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const commit = () => {
    if (committed || ended) return;
    if (realRes.writableEnded || realRes.destroyed) { ended = true; clearTimer(); return; }
    committed = true;
    clearTimer();
    realRes.writeHead(headerStatus, headerObj);
    if (pending.length === 0) realRes.flushHeaders?.();
    for (const buf of pending) realRes.write(buf);
    pending = [];
    pendingBytes = 0;
    pendingFrames = 0;
    inspectedChars = 0;
  };

  const finishError = (error) => {
    if (ended) return;
    ended = true;
    clearTimer();
    if (realRes.writableEnded || realRes.destroyed) return;
    const mapped = mapStatus(error, mapError);
    const retry = retryAfterSeconds(error);
    const fallbackType = (mapError ? mapError(error).type : connectErrorToHttp(error?.code).type);
    const type = normalizeOpenAIErrorType(error?.type || fallbackType, mapped);
    const body = errorBody
      ? errorBody(error, mapped)
      : {
        error: {
          message: error?.message || 'Upstream error',
          type,
          ...(error?.code ? { code: error.code } : {}),
        },
        ...(requestId ? { request_id: requestId } : {}),
      };
    const outHeaders = {};
    for (const [k, v] of Object.entries(headerObj)) {
      if (k.toLowerCase() !== 'content-type') outHeaders[k] = v;
    }
    outHeaders['content-type'] = 'application/json; charset=utf-8';
    if (retry) outHeaders['retry-after'] = String(retry);
    try {
      realRes.writeHead(mapped, outHeaders);
      realRes.end(JSON.stringify(body));
    } catch {
      ended = true;
    }
  };

  const inspectPending = () => {
    const text = Buffer.concat(pending).toString('utf8');
    let offset = inspectedChars;
    let framesSeen = 0;
    for (;;) {
      const found = findFrameEnd(text, offset);
      if (!found) break;
      framesSeen += 1;
      const frame = text.slice(offset, found.frameEnd);
      const error = errorFromFrame(frame);
      if (error) {
        finishError(error);
        return;
      }
      if (!isBootstrapFrame(frame, protocol)) {
        commit();
        return;
      }
      offset = found.next;
      inspectedChars = offset;
    }
    pendingFrames += framesSeen;
    // Keep holding; a later content/error frame decides. The timer is the
    // escape hatch so a silent upstream still commits a live SSE response.
    if (pendingFrames > maxFrames || pendingBytes > maxBytes) commit();
  };

  if (bootstrapMs > 0) {
    timer = setTimeout(() => {
      if (!committed && !ended) commit();
    }, bootstrapMs);
    timer.unref?.();
  }

  return {
    get writableEnded() { return ended; },
    get headersSent() { return committed; },
    get statusCode() { return headerStatus; },
    set statusCode(v) { headerStatus = v; },
    setHeader(name, value) {
      if (committed) return realRes.setHeader(name, value);
      headerObj[name] = value;
      return this;
    },
    getHeader(name) {
      if (committed) return realRes.getHeader(name);
      return headerObj[name];
    },
    removeHeader(name) {
      if (committed) return realRes.removeHeader(name);
      delete headerObj[name];
    },
    writeHead(nextStatus, nextHeaders) {
      if (ended) return this;
      if (committed) return realRes.writeHead(nextStatus, nextHeaders);
      headerStatus = nextStatus;
      headerObj = { ...headerObj, ...(nextHeaders || {}) };
      return this;
    },
    flushHeaders() { commit(); },
    write(chunk, encoding, cb) {
      if (ended || disposed) return false;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
      if (committed) {
        const ok = realRes.write(buf);
        if (typeof cb === 'function') process.nextTick(cb);
        return ok;
      }
      pending.push(buf);
      pendingBytes += buf.length;
      inspectPending();
      if (typeof cb === 'function') process.nextTick(cb);
      return true;
    },
    end(chunk, encoding, cb) {
      if (ended || disposed) return this;
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      if (!committed && !ended) commit();
      if (!ended) {
        ended = true;
        clearTimer();
        realRes.end(typeof cb === 'function' ? cb : undefined);
      }
      return this;
    },
    on(event, listener) { realRes.on(event, listener); return this; },
    once(event, listener) { realRes.once(event, listener); return this; },
    removeListener(event, listener) { realRes.removeListener(event, listener); return this; },
    emit(event, ...args) { return realRes.emit?.(event, ...args); },
    dispose() { disposed = true; ended = true; clearTimer(); },
    destroy(error) { disposed = true; ended = true; clearTimer(); return realRes.destroy?.(error); },
    get socket() { return realRes.socket; },
  };
}

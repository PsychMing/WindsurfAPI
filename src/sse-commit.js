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

const DEFAULT_MAX_FRAMES = 48;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_BOOTSTRAP_MS = 20_000;

const STATUS_BY_CODE = Object.freeze({
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  MODEL_BLOCKED: 403,
  CONTENT_BLOCKED: 400,
  UPSTREAM_ERROR: 502,
  STREAM_TRUNCATED: 502,
  TIMEOUT: 504,
  DEADLINE_EXCEEDED: 504,
  CAPACITY: 503,
  QUOTA_EXHAUSTED: 429,
});

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
      return obj.choices.every((c) => !c?.delta?.content && !c?.delta?.tool_calls && !c?.finish_reason);
    }
  }
  return false;
}

function errorFromFrame(frame) {
  const obj = parseFrameJson(frame);
  if (!obj || !obj.error || typeof obj.error !== 'object') return null;
  return obj.error;
}

function mapStatus(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  return STATUS_BY_CODE[error?.code] || 502;
}

function retryAfterSeconds(error, status) {
  const ms = Number(error?.retry_after_ms ?? error?.retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return Math.max(1, Math.ceil(ms / 1000));
  if (status === 429) return 5;
  return null;
}

export function createDeferredSseResponse(realRes, {
  status = 200,
  headers = {},
  protocol = 'openai',
  requestId = null,
  errorBody = null,
  maxFrames = DEFAULT_MAX_FRAMES,
  maxBytes = DEFAULT_MAX_BYTES,
  bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_MS,
} = {}) {
  let committed = false;
  let ended = false;
  let headerStatus = status;
  let headerObj = { ...headers };
  let pending = [];
  let pendingBytes = 0;
  let pendingFrames = 0;
  let inspectedChars = 0;
  let timer = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const commit = () => {
    if (committed || ended) return;
    committed = true;
    clearTimer();
    realRes.writeHead(headerStatus, headerObj);
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
    const mapped = mapStatus(error);
    const retry = retryAfterSeconds(error, mapped);
    const body = errorBody
      ? errorBody(error, mapped)
      : {
        error: {
          message: error?.message || 'Upstream error',
          type: error?.type || (mapped === 429 ? 'rate_limit_error' : 'api_error'),
          ...(error?.code ? { code: error.code } : {}),
        },
        ...(requestId ? { request_id: requestId } : {}),
      };
    const outHeaders = { ...headerObj, 'content-type': 'application/json' };
    if (retry) outHeaders['retry-after'] = String(retry);
    realRes.writeHead(mapped, outHeaders);
    realRes.end(JSON.stringify(body));
  };

  const inspectPending = () => {
    const text = Buffer.concat(pending).toString('utf8');
    let offset = inspectedChars;
    for (;;) {
      const idx = text.indexOf('\n\n', offset);
      if (idx === -1) break;
      const frame = text.slice(offset, idx);
      const error = errorFromFrame(frame);
      if (error) {
        finishError(error);
        return;
      }
      if (!isBootstrapFrame(frame, protocol)) {
        commit();
        return;
      }
      offset = idx + 2;
      inspectedChars = offset;
    }
    // Keep holding; a later content/error frame decides. The timer is the
    // escape hatch so a silent upstream still commits a live SSE response.
    if (pendingFrames > maxFrames || pendingBytes > maxBytes) commit();
  };

  if (bootstrapTimeoutMs > 0) {
    timer = setTimeout(() => {
      if (!committed && !ended) commit();
    }, bootstrapTimeoutMs);
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
      if (committed) return realRes.writeHead(nextStatus, nextHeaders);
      headerStatus = nextStatus;
      headerObj = { ...headerObj, ...(nextHeaders || {}) };
      return this;
    },
    flushHeaders() { commit(); },
    write(chunk, encoding, cb) {
      if (ended) return false;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
      if (committed) {
        const ok = realRes.write(buf);
        if (typeof cb === 'function') process.nextTick(cb);
        return ok;
      }
      pending.push(buf);
      pendingBytes += buf.length;
      pendingFrames += 1;
      inspectPending();
      if (typeof cb === 'function') process.nextTick(cb);
      return true;
    },
    end(chunk, encoding, cb) {
      if (ended) return this;
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
    destroy(error) { ended = true; clearTimer(); return realRes.destroy?.(error); },
    get socket() { return realRes.socket; },
  };
}

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
import { findFrameEnd, parseSseLine } from './sse-framer.js';
import { connectErrorToHttp, normalizeOpenAIErrorType, clientRetryAfterSeconds } from './handlers/chat.js';

const DEFAULT_MAX_FRAMES = 48;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_BOOTSTRAP_MS = 5_000;
const MAX_BOOTSTRAP_MS = 14_000;

// A heartbeat frame is comment-only. A leading comment on a frame that also
// carries data must not make that data a bootstrap.
function isCommentFrame(frame) {
  let sawComment = false;
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line === '') continue;
    if (!line.startsWith(':')) return false;
    sawComment = true;
  }
  return sawComment;
}

function dataPayload(frame) {
  const data = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    const parsed = parseSseLine(line);
    if (parsed?.field === 'data') data.push(parsed.value);
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

function isBootstrapFrame(frame, protocol, isBootstrap = null) {
  if (isCommentFrame(frame)) return true;
  const obj = parseFrameJson(frame);
  if (!obj) return false;
  if (typeof isBootstrap === 'function') return !!isBootstrap(obj);
  if (protocol === 'openai') {
    // Role-only prime chunk: no content, no tool call, no finish. Holding it is
    // safe because a client cannot observe anything from it alone.
    if (Array.isArray(obj.choices) && obj.choices.length > 0) {
      return obj.choices.every((c) => {
        const d = c?.delta;
        if (!d || c?.finish_reason) return false;
        return Object.keys(d).every((k) => k === 'role'
          || ((k === 'content' || k === 'reasoning' || k === 'reasoning_content') && !d[k]));
      });
    }
  }
  return false;
}

function errorFromFrame(frame, parseError = null) {
  const obj = parseFrameJson(frame);
  if (!obj) return null;
  if (typeof parseError === 'function') return parseError(obj);
  if (!obj.error || typeof obj.error !== 'object') return null;
  return obj.error;
}

const GRPC_STATUS = {
  INVALID_ARGUMENT: 400,
  OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  ABORTED: 409,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNIMPLEMENTED: 501,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

const TYPE_STATUS = {
  invalid_request_error: 400,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  rate_limit_exceeded: 429,
  authentication_error: 401,
  permission_error: 403,
  insufficient_quota: 402,
  capacity_error: 503,
  api_error: 500,
  overloaded_error: 529,
  timeout_error: 504,
};

function mapStatus(error, mapError, protocol = '') {
  if (typeof mapError === 'function') return mapError(error).status;
  // Gemini's error envelope carries the HTTP-like status in numeric `code`
  // (e.g. 400/413/404), while `status` is the gRPC enum. Prefer the numeric
  // code so 413 is not flattened to INVALID_ARGUMENT/400.
  const numeric = Number.isInteger(error?.code)
    ? error.code
    : (Number.isInteger(error?.status) ? error.status : null);
  if (numeric >= 400 && numeric <= 599) return numeric;
  if (error?.status && GRPC_STATUS[error.status]) return GRPC_STATUS[error.status];
  const code = error?.__upstream_code
    || (typeof error?.code === 'string' ? error.code : null);
  // Messages is the one protocol whose Anthropic enum must win over the
  // internal Connect code (MODEL_BLOCKED → permission_error/403, while the
  // same code is 402 for OpenAI/Responses). Other protocols keep the code.
  if (protocol === 'messages' && error?.type && TYPE_STATUS[error.type]) return TYPE_STATUS[error.type];
  if (code) {
    const byCode = connectErrorToHttp(code);
    if (byCode.status !== 502) return byCode.status;
  }
  if (error?.type && TYPE_STATUS[error.type]) return TYPE_STATUS[error.type];
  return 502;
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
  isBootstrap = null,
  parseError = null,
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
  // O10: the first failure this stream surfaced, kept after it is delivered so
  // the caller can classify the request-ring row. The commit gate already
  // parses frames until it commits; from then on an error frame cannot change
  // the status any more, but it still has to reach the ring.
  let failure = null;

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
    if (!failure) failure = error;
    ended = true;
    clearTimer();
    if (realRes.writableEnded || realRes.destroyed) return;
    const mapped = mapStatus(error, mapError, protocol);
    const retry = retryAfterSeconds(error);
    const fallbackType = (mapError ? mapError(error).type : connectErrorToHttp(error?.code).type);
    const type = normalizeOpenAIErrorType(
      error?.type && error.type !== 'api_error' ? error.type : fallbackType,
      mapped,
    );
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
      headerStatus = mapped;
      committed = true;
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
      const error = errorFromFrame(frame, parseError);
      if (error) {
        finishError(error);
        return;
      }
      if (!isBootstrapFrame(frame, protocol, isBootstrap)) {
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
    // O10: first failure frame this stream carried (pre- or post-commit), or
    // null. Read by serveChatStream after the handler settles to classify the
    // request-ring row; it never changes what was sent to the client.
    get failure() { return failure; },
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
        // O10: a failure that lands after the commit gate is already on the
        // wire with HTTP 200, so it cannot rewrite the status — but the request
        // ring must still record its class. Scan for the `"error"` key first:
        // JSON-escaped content cannot produce that exact byte sequence (inner
        // quotes carry a backslash), and a false positive is rejected by
        // `parseError` below because the frame is parsed as a whole.
        if (!failure && buf.indexOf('"error"') !== -1) {
          const error = errorFromFrame(buf.toString('utf8'), parseError);
          if (error) failure = error;
        }
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

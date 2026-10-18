// Tool-ID hygiene and tool-pairing repair.
//
// Ported from Any2API `src/translate/hygiene/hygiene.go` and
// `src/translate/toolcall/history.go` with two deliberate changes:
//   - valid IDs are identity (no rewrite on the client-visible leg);
//   - orphan tool results are folded into text, never dropped.
//
// Request-scoped: no global mutable state.

import { createHash } from 'node:crypto';

export const MAX_TOOL_ID_LEN = 64;
export const INTERRUPTED_RESULT_TEXT = 'Tool call was interrupted before any output was recorded.';
export const EMPTY_RESULT_TEXT = 'Tool result was empty.';

const ID_RE = /^[A-Za-z0-9_-]+$/;

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function isValidToolId(id, { maxLen = MAX_TOOL_ID_LEN, charsetOnly = false } = {}) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (!ID_RE.test(id)) return false;
  return charsetOnly ? true : id.length <= maxLen;
}

export function sanitizeToolId(id, { maxLen = MAX_TOOL_ID_LEN, charsetOnly = false } = {}) {
  if (id === undefined || id === null || id === '') return '';
  const raw = String(id);
  if (isValidToolId(raw, { maxLen, charsetOnly })) return raw;
  let s = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!charsetOnly && s.length > maxLen) {
    const hash = sha256Hex(s).slice(0, 16);
    s = `${s.slice(0, Math.max(0, maxLen - 17))}_${hash}`;
  }
  return s;
}

export function synthToolId(base, seed, slot) {
  const prefix = `${base || 'call'}_synth_`;
  if (seed === undefined || seed === null || seed === '') return `${prefix}${slot}`;
  return `${prefix}${sha256Hex(`${seed}\u0000${slot}`).slice(0, 32)}`;
}

export function wireToolId(base, id, seed, slot, opts = {}) {
  return sanitizeToolId(id, opts) || synthToolId(base, seed, slot);
}

export function foldOrphanResultText(content) {
  const text = typeof content === 'string' ? content.trim() : String(content ?? '').trim();
  return text || EMPTY_RESULT_TEXT;
}

function appendText(content, text) {
  if (typeof content === 'string' || content == null) {
    return content ? `${content}\n\n${text}` : text;
  }
  if (Array.isArray(content)) return [...content, { type: 'text', text }];
  return text;
}

export function knownToolCallIds(messages) {
  const ids = new Set();
  for (const m of messages || []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (tc?.id) ids.add(tc.id);
    }
  }
  return ids;
}

export function normalizeToolIdsInMessages(messages, { seed = '', maxLen = MAX_TOOL_ID_LEN, charsetOnly = false } = {}) {
  if (!Array.isArray(messages)) return messages;
  let slot = 0;
  let changed = false;
  const out = messages.map((m) => {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      let localChanged = false;
      const calls = m.tool_calls.map((tc) => {
        const id = wireToolId('call', tc?.id, seed, slot++, { maxLen, charsetOnly });
        if (id !== tc?.id) {
          localChanged = true;
          return { ...tc, id };
        }
        return tc;
      });
      if (localChanged) {
        changed = true;
        return { ...m, tool_calls: calls };
      }
    }
    if (m?.role === 'tool') {
      const id = sanitizeToolId(m.tool_call_id, { maxLen, charsetOnly });
      if (id !== m.tool_call_id) {
        changed = true;
        return { ...m, tool_call_id: id };
      }
    }
    return m;
  });
  return changed ? out : messages;
}

export function foldOrphanToolResults(messages) {
  if (!Array.isArray(messages)) return messages;
  const known = knownToolCallIds(messages);
  let changed = false;
  const out = [];
  for (const m of messages) {
    if (m?.role === 'tool' && (!m.tool_call_id || !known.has(m.tool_call_id))) {
      changed = true;
      const folded = `${m.tool_call_id ? `[tool result for ${m.tool_call_id}]\n` : '[tool result]\n'}${foldOrphanResultText(m.content)}`;
      const prev = out[out.length - 1];
      if (prev?.role === 'user') {
        out[out.length - 1] = { ...prev, content: appendText(prev.content, folded) };
      } else {
        out.push({ role: 'user', content: folded });
      }
    } else {
      out.push(m);
    }
  }
  return changed ? out : messages;
}

export function synthesizeMissingResults(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    out.push(m);
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    // A trailing assistant call is the normal "awaiting execution" shape.
    if (i === messages.length - 1) continue;
    const existing = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === 'tool') {
      existing.push(messages[j]);
      j += 1;
    }
    for (const tm of existing) out.push(tm);
    const have = new Set(existing.map((tm) => tm.tool_call_id).filter(Boolean));
    const missing = m.tool_calls.filter((tc) => tc?.id && !have.has(tc.id));
    if (missing.length) {
      changed = true;
      for (const tc of missing) {
        out.push({ role: 'tool', tool_call_id: tc.id, content: INTERRUPTED_RESULT_TEXT });
      }
    }
    i = j - 1;
  }
  return changed ? out : messages;
}

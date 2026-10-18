import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOOL_ID_LEN,
  INTERRUPTED_RESULT_TEXT,
  EMPTY_RESULT_TEXT,
  isValidToolId,
  sanitizeToolId,
  synthToolId,
  wireToolId,
  foldOrphanResultText,
  normalizeToolIdsInMessages,
  foldOrphanToolResults,
  synthesizeMissingResults,
} from '../src/tool-ids.js';

describe('tool-id hygiene', () => {
  it('leaves a valid id byte-identical', () => {
    assert.equal(sanitizeToolId('call_abc-123'), 'call_abc-123');
  });

  it('truncates a 70-char id to 64 and is idempotent', () => {
    const raw = 'a'.repeat(70);
    const once = sanitizeToolId(raw);
    assert.equal(once.length, MAX_TOOL_ID_LEN);
    assert.equal(sanitizeToolId(once), once);
    assert.equal(isValidToolId(once), true);
  });

  it('replaces illegal characters', () => {
    assert.equal(sanitizeToolId('call.with:dots/slash'), 'call_with_dots_slash');
  });

  it('synth ids are deterministic per seed/slot and differ across seeds', () => {
    const a = synthToolId('call', 'resp_a', 0);
    const b = synthToolId('call', 'resp_a', 0);
    const c = synthToolId('call', 'resp_b', 0);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^call_synth_[0-9a-f]{32}$/);
  });

  it('wireToolId keeps a valid id and synthesizes a missing one', () => {
    assert.equal(wireToolId('call', 'call_ok', 'resp', 0), 'call_ok');
    assert.match(wireToolId('call', '', 'resp', 3), /^call_synth_[0-9a-f]{32}$/);
  });

  it('normalizes assistant ids and the matching tool result in one pass', () => {
    const raw = 'x'.repeat(70);
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: raw, type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: raw, content: 'ok' },
    ];
    const out = normalizeToolIdsInMessages(messages, { seed: 'resp' });
    const id = out[1].tool_calls[0].id;
    assert.equal(id.length, 64);
    assert.equal(out[2].tool_call_id, id);
  });

  it('returns the same array when nothing changes', () => {
    const messages = [{ role: 'assistant', tool_calls: [{ id: 'call_ok', function: { name: 'f' } }] }];
    assert.equal(normalizeToolIdsInMessages(messages), messages);
  });

  it('folds an orphan tool result into text instead of dropping it', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'missing', content: 'important output' },
    ];
    const out = foldOrphanToolResults(messages);
    assert.equal(out.length, 1);
    assert.match(out[0].content, /important output/);
    assert.match(out[0].content, /\[tool result for missing\]/);
  });

  it('uses the empty-result placeholder for whitespace-only orphans', () => {
    assert.equal(foldOrphanResultText('   '), EMPTY_RESULT_TEXT);
  });

  it('synthesizes an interrupted result for a non-trailing call', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'f' } }] },
      { role: 'user', content: 'next' },
    ];
    const out = synthesizeMissingResults(messages);
    assert.equal(out[1].role, 'tool');
    assert.equal(out[1].tool_call_id, 'call_1');
    assert.equal(out[1].content, INTERRUPTED_RESULT_TEXT);
  });

  it('does not synthesize for a trailing assistant call', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'f' } }] },
    ];
    assert.equal(synthesizeMissingResults(messages), messages);
  });
});

describe('foldOrphanResultText', () => {
  it('preserves text parts from array content instead of stringifying objects', () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'call_missing', content: [
        { type: 'text', text: 'IMPORTANT-TEXT' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      ] },
    ];
    const out = foldOrphanToolResults(messages);
    assert.match(out[0].content, /IMPORTANT-TEXT/);
    assert.match(out[0].content, /\[image_url\]/);
    assert.doesNotMatch(out[0].content, /\[object Object\]/);
  });
});

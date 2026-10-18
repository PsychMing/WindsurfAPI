import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';

describe('Anthropic tool-id hygiene', () => {
  it('normalizes a 70-char tool id and keeps the result paired', async () => {
    const raw = 'x'.repeat(70);
    let captured = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: raw, name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: raw, content: 'ok' }] },
      ],
    }, { handleChatCompletions: async (body) => {
      captured = body;
      return {
        status: 200,
        body: { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: {} },
      };
    } });
    assert.equal(result.status, 200);
    const call = captured.messages[0].tool_calls[0];
    assert.equal(call.id.length, 64);
    assert.equal(captured.messages[1].tool_call_id, call.id);
  });

  it('the kill switch leaves ids raw', async () => {
    const raw = 'x'.repeat(70);
    const previous = process.env.WINDSURFAPI_TOOL_HYGIENE;
    process.env.WINDSURFAPI_TOOL_HYGIENE = '0';
    try {
      let captured = null;
      await handleMessages({
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: raw, name: 'f', input: {} }] }],
      }, { handleChatCompletions: async (body) => {
        captured = body;
        return { status: 200, body: { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: {} } };
      } });
      assert.equal(captured.messages[0].tool_calls[0].id, raw);
    } finally {
      if (previous === undefined) delete process.env.WINDSURFAPI_TOOL_HYGIENE;
      else process.env.WINDSURFAPI_TOOL_HYGIENE = previous;
    }
  });

  it('folds an orphan tool result instead of forwarding an unpaired role:tool', async () => {
    let captured = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan body' }] },
      ],
    }, { handleChatCompletions: async (body) => {
      captured = body;
      return {
        status: 200,
        body: { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: {} },
      };
    } });
    assert.equal(result.status, 200);
    assert.equal(captured.messages.some((m) => m.role === 'tool'), false);
    assert.match(JSON.stringify(captured.messages), /orphan body/);
  });
});

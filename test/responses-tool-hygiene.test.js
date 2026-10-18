import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { responsesToChat, chatToResponse, handleResponses } from '../src/handlers/responses.js';
import { isValidToolId } from '../src/tool-ids.js';

const longName = 'n'.repeat(70);

describe('Responses tool boundary', () => {
  it('bounds a long tool name upstream and restores it on egress', () => {
    const chat = responsesToChat({
      model: 'gpt-4o',
      input: 'hi',
      tools: [{ type: 'function', name: longName, parameters: { type: 'object' } }],
    });
    const wire = chat.tools[0].function.name;
    assert.equal(wire.length, 64);
    assert.equal(chat.__toolNameMap.toUpstream.get(longName), wire);
    const response = chatToResponse({
      choices: [{ message: { tool_calls: [{ id: 'call_1', function: { name: wire, arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    }, 'gpt-4o', 'resp_1', 'msg_1', chat.tools, chat.__toolNameMap);
    assert.equal(response.output.find((o) => o.type === 'function_call').name, longName);
  });

  it('sanitizes invalid call ids on the route ingress and egress', async () => {
    let captured = null;
    const result = await handleResponses({
      model: 'gpt-4o',
      input: [
        { type: 'function_call', call_id: 'call.with:dots/slash', name: 'f', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call.with:dots/slash', output: 'ok' },
      ],
    }, {
      handleChatCompletions: async (body) => {
        captured = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'call.with:dots/slash', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
            usage: {},
          },
        };
      },
      context: { callerKey: 'api:test:user:t' },
    });
    const call = captured.messages.find((m) => m.tool_calls).tool_calls[0];
    assert.equal(call.id, 'call_with_dots_slash');
    assert.equal(captured.messages.find((m) => m.role === 'tool').tool_call_id, call.id);
    const item = result.body.output.find((o) => o.type === 'function_call');
    assert.equal(isValidToolId(item.call_id), true);
  });

  it('keeps a valid 64-char name unchanged', () => {
    const name = 'a'.repeat(64);
    const chat = responsesToChat({ model: 'gpt-4o', input: 'hi', tools: [{ type: 'function', name }] });
    assert.equal(chat.tools[0].function.name, name);
    assert.equal(chat.__toolNameMap, undefined);
  });
});

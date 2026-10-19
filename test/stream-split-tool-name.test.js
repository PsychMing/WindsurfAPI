import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleGemini } from '../src/handlers/gemini.js';

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; },
    setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const sseJson = (body) => body.split(/\r?\n\r?\n/).filter(Boolean)
  .map((f) => f.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
  .filter((data) => data && data.trim() !== '[DONE]')
  .map((data) => JSON.parse(data));

const SPLIT = [
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'foo' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: '_bar', arguments: '{}' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
];

function streamDeps(frames) {
  return {
    async handleChatCompletions() {
      return {
        status: 200, stream: true,
        async handler(res) { for (const f of frames) res.write(f); res.end(); },
      };
    },
  };
}

describe('streaming split function.name is settled before egress', () => {
  it('Gemini functionCall carries the restored full name', async () => {
    const result = await handleGemini('m', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
      tools: [{ functionDeclarations: [{ name: 'foo.bar' }] }],
    }, streamDeps(SPLIT), { stream: true, alt: 'sse' });
    const res = fakeRes();
    await result.handler(res);
    const calls = sseJson(res.body)
      .flatMap((f) => f.candidates?.[0]?.content?.parts || [])
      .map((p) => p.functionCall)
      .filter(Boolean);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'foo.bar');
  });
});

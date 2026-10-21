// Three verified defects in src/client.js, pinned at their seams:
//
// 1. The Cascade history budget compared UTF-16 `line.length` while the wire
//    encoder writes UTF-8 (proto.js uses Buffer.byteLength), so a CJK history
//    could "fit" 600 KB and reach the wire at ~1.8 MB.
// 2. The trajectory poll loop never advanced `stepOffset`, so every 500 ms
//    poll re-fetched the whole trajectory (and the resume entry recorded an
//    offset that was really the last batch size).
// 3. `isCascadeTransportError` matched /panel state/i, including the
//    deterministic terminal error the Send retry loop synthesizes after
//    MAX_PANEL_RETRIES — that one rotated an oversized payload across every
//    account instead of surfacing.
//
// The budget tests drive `cascadeChat` against a fake HTTP/2 language server
// and measure the prompt the client actually sends. The offset test uses the
// same seam and asserts on the GetCascadeTrajectorySteps requests. The
// classification test calls the exported pure function.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';

Object.assign(process.env, {
  GRPC_PROTOCOL: 'connect',
  CASCADE_POLL_INTERVAL_MS: '10',
  CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '2000',
  CASCADE_COLD_STALL_BASE_MS: '2000',
  CASCADE_WARM_STALL_MS: '2000',
  WINDSURFAPI_USER_JWT: '0',
});
delete process.env.DEVIN_CONNECT;
delete process.env.DEVIN_ONLY;

const { isCascadeTransportError, WindsurfClient } = await import('../src/client.js');
const { unwrapRequest, wrapEnvelope, endOfStreamEnvelope } = await import('../src/connect.js');
const {
  getField, parseFields, writeMessageField, writeStringField, writeVarintField,
} = await import('../src/proto.js');

// 3 UTF-8 bytes, 1 UTF-16 code unit.
const CJK = '漢';

function plannerStep(text) {
  return Buffer.concat([
    writeVarintField(1, 15), // CORTEX_STEP_TYPE_PLANNER_RESPONSE
    writeVarintField(4, 3),  // STATUS_DONE
    writeMessageField(20, writeStringField(1, text)),
  ]);
}

function stepsResponse(texts) {
  return Buffer.concat(texts.map((text) => writeMessageField(1, plannerStep(text))));
}

function readStepOffset(payload) {
  const field = getField(parseFields(payload), 2, 0);
  return field ? Number(field.value) : 0;
}

function readSendText(payload) {
  const scope = getField(parseFields(payload), 2, 2);
  return getField(parseFields(scope.value), 1, 2).value.toString('utf8');
}

function respond(stream, headers, body) {
  stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/connect+proto' });
  stream.end(Buffer.concat([wrapEnvelope(body, { compress: false }), endOfStreamEnvelope()]));
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

// Runs one fresh cascade and returns the prompt text of every
// SendUserCascadeMessage the fake LS received.
async function runFreshCascade(messages) {
  const sent = [];
  await withFakeLanguageServer((stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const method = String(headers[':path']).split('/').pop();
      const payload = unwrapRequest(Buffer.concat(chunks), headers);
      let body = Buffer.alloc(0);

      if (method === 'StartCascade') body = writeStringField(1, 'budget-cascade');
      if (method === 'SendUserCascadeMessage') sent.push(readSendText(payload));
      if (method === 'GetCascadeTrajectorySteps' && readStepOffset(payload) === 0) {
        body = stepsResponse(['answer']);
      }
      if (method === 'GetCascadeTrajectory') body = writeVarintField(2, 1); // IDLE
      respond(stream, headers, body);
    });
  }, async (port) => {
    const client = new WindsurfClient('test-api-key', port, 'csrf-token');
    await client.cascadeChat(messages, 0, 'claude-sonnet-4-6');
  });
  assert.equal(sent.length, 1, 'exactly one SendUserCascadeMessage per cascade');
  return sent[0];
}

describe('Cascade history budget counts UTF-8 bytes', () => {
  it('trims a CJK history that fits 600 KB as UTF-16 but is ~3x over as UTF-8', async () => {
    const previous = process.env.CASCADE_MAX_HISTORY_BYTES;
    process.env.CASCADE_MAX_HISTORY_BYTES = '600000';
    try {
      // Three 199,000-char turns: 597,024 UTF-16 units each including markup
      // (597,072 total, under the 600 KB budget) but 597,024 UTF-8 bytes each
      // (~1.79 MB total). Counting units kept all three; counting bytes keeps
      // only the newest.
      const prior = Array.from({ length: 3 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `${CJK.repeat(199_000)}TURN_${i}`,
      }));
      const text = await runFreshCascade([...prior, { role: 'user', content: 'latest turn' }]);
      const wire = Buffer.byteLength(text, 'utf8');

      assert.ok(wire < 650_000, `prompt is ${wire} bytes; UTF-16 counting sent ~1.79 MB`);
      assert.ok(text.includes('TURN_2'), 'the newest prior turn survives');
      assert.ok(!text.includes('TURN_0') && !text.includes('TURN_1'), 'the older turns are dropped');
      assert.match(text, /truncation_note.*2 earlier turns were dropped/);
    } finally {
      if (previous === undefined) delete process.env.CASCADE_MAX_HISTORY_BYTES;
      else process.env.CASCADE_MAX_HISTORY_BYTES = previous;
    }
  });

  it('counts the prepended system prompt in the same UTF-8 units', async () => {
    const previous = process.env.CASCADE_MAX_HISTORY_BYTES;
    process.env.CASCADE_MAX_HISTORY_BYTES = '600000';
    try {
      // 100,000 CJK chars of system prompt are 300,000 wire bytes (but
      // 100,000 units). Each history line is ~180,024 bytes. Only one line
      // fits after the prompt; counting units would have kept both.
      const system = CJK.repeat(100_000);
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: `${CJK.repeat(60_000)}TURN_0` },
        { role: 'assistant', content: `${CJK.repeat(60_000)}TURN_1` },
        { role: 'user', content: 'latest turn' },
      ];
      const text = await runFreshCascade(messages);
      const wire = Buffer.byteLength(text, 'utf8');

      assert.ok(wire < 600_000, `prompt is ${wire} bytes; UTF-16 counting sent ~660 KB`);
      assert.ok(text.includes('TURN_1'), 'the newest prior turn survives');
      assert.ok(!text.includes('TURN_0'), 'the older turn no longer fits after the 300 KB prompt');
    } finally {
      if (previous === undefined) delete process.env.CASCADE_MAX_HISTORY_BYTES;
      else process.env.CASCADE_MAX_HISTORY_BYTES = previous;
    }
  });
});

describe('Cascade trajectory polling advances stepOffset', () => {
  it('does not re-request offset 0 after the first batch', async () => {
    const offsets = [];
    let stepPolls = 0;

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        const method = String(headers[':path']).split('/').pop();
        const payload = unwrapRequest(Buffer.concat(chunks), headers);
        let body = Buffer.alloc(0);

        if (method === 'StartCascade') body = writeStringField(1, 'advance-cascade');
        if (method === 'GetCascadeTrajectorySteps') {
          const offset = readStepOffset(payload);
          offsets.push(offset);
          stepPolls++;
          // Two new steps per batch: offsets 0 -> 2 -> 4 (end).
          if (offset < 4) body = stepsResponse([`S${offset}`, `S${offset + 1}`]);
        }
        if (method === 'GetCascadeTrajectory') {
          // ACTIVE for the first two batches, then IDLE so the loop can finish.
          body = writeVarintField(2, stepPolls >= 2 ? 1 : 2);
        }
        respond(stream, headers, body);
      });
    }, async (port) => {
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat(
        [{ role: 'user', content: 'go' }], 0, 'claude-sonnet-4-6',
      );
      const text = chunks.map((chunk) => chunk.text || '').join('');

      assert.deepEqual(offsets.slice(0, 2), [0, 2], `poll offsets were ${offsets.join(',')}`);
      assert.ok(!offsets.slice(1).includes(0), `offset 0 was re-requested: ${offsets.join(',')}`);
      assert.equal(text, 'S0S1S2S3', 'each trajectory step is emitted once, in order');
      assert.equal(chunks.stepOffset, 4, 'the resume offset is the absolute next step');
    });
  });

  it('keeps resume semantics: starts at the stored offset and returns the absolute next step', async () => {
    const offsets = [];

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        const method = String(headers[':path']).split('/').pop();
        const payload = unwrapRequest(Buffer.concat(chunks), headers);
        let body = Buffer.alloc(0);

        if (method === 'GetCascadeTrajectorySteps') {
          const offset = readStepOffset(payload);
          offsets.push(offset);
          if (offset === 5) body = stepsResponse(['R5', 'R6']);
        }
        if (method === 'GetCascadeTrajectory') body = writeVarintField(2, 1); // IDLE
        respond(stream, headers, body);
      });
    }, async (port) => {
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat(
        [{ role: 'user', content: 'continue' }], 0, 'claude-sonnet-4-6',
        {
          reuseEntry: {
            cascadeId: 'resume-cascade',
            sessionId: 'resume-session',
            lsPort: port,
            apiKey: 'test-api-key',
            stepOffset: 5,
            generatorOffset: 5,
          },
        },
      );
      const text = chunks.map((chunk) => chunk.text || '').join('');

      assert.equal(offsets[0], 5, 'resume must poll from the stored offset');
      assert.equal(text, 'R5R6', 'only the new steps are streamed');
      assert.equal(chunks.stepOffset, 7, 'the stored offset plus the new steps');
    });
  });
});

describe('Cascade transport classification', () => {
  it('does not treat the synthesized terminal panel-loss error as transient', () => {
    const terminal = new Error(
      'Panel state lost 2 times after re-warm — likely an LS-level issue with very large '
      + 'payloads (350000 chars). Try reducing system prompt size or tool count.',
    );
    assert.equal(isCascadeTransportError(terminal), false);
  });

  it('still treats genuine panel-state transport errors as transient', () => {
    assert.equal(isCascadeTransportError(new Error('panel state not found for session abc')), true);
    assert.equal(
      isCascadeTransportError(new Error('InitializeCascadePanelState failed: panel state lost')),
      true,
      'an LS-originated panel-state loss (no synthesized "after re-warm" suffix) stays transient',
    );
  });
});

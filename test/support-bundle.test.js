// Tests for scripts/support-bundle.mjs (GapSweep2 §3.1).
//
// The bundle exists so a reporter can attach one file instead of hand-collecting traces.
// That makes two properties load-bearing and both are pinned here:
//
//   1. The archive must not carry a credential. Text legs are redacted before packaging and
//      the shared secret rules (scripts/secret-rules.mjs) are the gate; a hit refuses the
//      whole bundle. The planted token below is shaped like a real `sk-` key, so a redactor
//      that only handles field names cannot pass this test.
//   2. The archive must still carry the evidence. The raw upstream leg is binary; a bundler
//      that "cleans" it (UTF-8 decode, re-encode, compression) destroys the bytes the issue
//      is about. It is asserted byte-for-byte, and manifest.json's sha256 is asserted against
//      the bytes actually stored in the zip rather than against the source file.
//
// The zip reader is deliberately local: the repository has no runtime dependencies, and
// shelling out to `unzip`/PowerShell would make the test platform-dependent. Store-method
// entries are trivial to read, and reading them here proves the archive is a real zip.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'support-bundle.mjs');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Contains a fixture marker on purpose: `test/` fixtures are allow-listed by shape in
// scripts/secret-rules.mjs, and this file is scanned by scripts/secret-scan.mjs on every
// gate run. The bundler stages it under `traces/…`, where that exemption does not apply, so
// it still trips the gate — which is exactly the behaviour under test.
const PLANTED_TOKEN = 'sk-fixtureA1b2C3d4E5f6G7h8I9j0K1l2M3';

// A binary leg with NUL, non-UTF-8 and ASCII bytes. Any decode/re-encode round trip changes
// it; a store-method zip entry preserves it exactly.
const BINARY_LEG = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0x41, 0x42, 0x43, 0x00, 0x0a, 0x10]);

const CLIENT_LEG = `${JSON.stringify({
  traceId: '0001-a',
  protocol: 'openai',
  headers: { Authorization: 'Bearer SECRET', 'x-api-key': 'SECRET-header-key' },
  callerKey: 'SECRET-caller',
  body: {
    model: 'claude-sonnet-4.6',
    messages: [{ role: 'user', content: 'hello' }],
  },
}, null, 2)}\n`;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Minimal reader for the store-only archives support-bundle writes. It walks the central
// directory (the authoritative index) and then each local header to find the data offset,
// so a malformed local header fails here instead of being papered over.
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'zip has an end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'central directory header signature');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `local header signature for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, {
      method,
      data: buffer.subarray(dataStart, dataStart + compressedSize),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function runBundle(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      WINDSURFAPI_SKIP_DOTENV: '1',
      ...env,
    },
  });
}

function writeTraceFile(root, traceId, name, content) {
  const dir = join(root, 'trace', traceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

describe('support-bundle', () => {
  let workspace;
  let outDir;
  let zipPath;
  let zipEntries;
  let manifest;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), 'windsurfapi-support-test-'));
    outDir = join(workspace, 'out');
    mkdirSync(outDir, { recursive: true });

    writeTraceFile(workspace, '0000-old', '01-client-req.json', '{"traceId":"0000-old"}\n');
    writeTraceFile(workspace, '0001-a', '01-client-req.json', CLIENT_LEG);
    writeTraceFile(workspace, '0001-a', '03-upstream-req.bin', BINARY_LEG);
    writeTraceFile(workspace, '0002-b', '05-client-res.json', '{"traceId":"0002-b","status":200}\n');

    // "Newest" must be decided by mtime, not by name alone: the directory names are
    // sortable here, but an operator copying traces around breaks that assumption.
    utimesSync(join(workspace, 'trace', '0000-old'), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(workspace, 'trace', '0001-a'), new Date(2_000_000), new Date(2_000_000));
    utimesSync(join(workspace, 'trace', '0002-b'), new Date(3_000_000), new Date(3_000_000));

    const result = runBundle(
      ['--trace-dir', join(workspace, 'trace'), '--out', outDir, '--traces', '2'],
      {
        WINDSURFAPI_TRACE: '1',
        WINDSURFAPI_TRACE_DIR: join(workspace, 'trace'),
        DEVIN_CONNECT: '1',
        CASCADE_MODE: 'native',
        WINDSURFAPI_FAKE_TOKEN: PLANTED_TOKEN,
      },
    );
    assert.equal(result.status, 0, `bundler failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const zips = readdirSync(outDir).filter((name) => name.endsWith('.zip'));
    assert.equal(zips.length, 1, 'exactly one bundle is written');
    zipPath = join(outDir, zips[0]);
    zipEntries = readZip(readFileSync(zipPath));
    manifest = JSON.parse(zipEntries.get('manifest.json').data.toString('utf8'));
  });

  after(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('redacts text credentials, keeps only the newest N traces, and snapshots switches safely', () => {
    assert.match(zipPath, /support-bundle-\d{8}T\d{6}Z\.zip$/, 'UTC-stamped file name');

    // Last-N selection: the oldest trace is omitted, the two newest are included.
    const names = [...zipEntries.keys()];
    assert.ok(names.includes('traces/0001-a/01-client-req.json'));
    assert.ok(names.includes('traces/0002-b/05-client-res.json'));
    assert.ok(!names.some((name) => name.includes('0000-old')), 'oldest trace is not in the bundle');

    // Redaction: no text entry carries the fixture secrets.
    for (const [name, entry] of zipEntries) {
      const text = entry.data.toString('utf8');
      assert.ok(!text.includes('SECRET'), `${name} must not contain the redacted header value`);
      assert.ok(!text.includes(PLANTED_TOKEN), `${name} must not contain the planted token`);
    }
    const client = zipEntries.get('traces/0001-a/01-client-req.json').data.toString('utf8');
    assert.match(client, /"Authorization": "\[redacted\]"/);
    assert.match(client, /"callerKey": "\[redacted\]"/);
    // The redaction is value-only: JSON structure and non-secret fields survive.
    assert.match(client, /"model": "claude-sonnet-4\.6"/);
    assert.doesNotThrow(() => JSON.parse(client), 'redacted JSON leg still parses');

    const environment = JSON.parse(zipEntries.get('environment.json').data.toString('utf8'));
    assert.equal(environment.version, PACKAGE_VERSION);
    assert.equal(environment.health.version, PACKAGE_VERSION);
    assert.equal(environment.health.packageVersion, PACKAGE_VERSION);
    assert.match(environment.health.commit, /^[a-f0-9]{7,12}$/, 'health commit is a git sha');
    assert.match(environment.health.source, /getVersionInfo/);
    assert.equal(environment.traces.source, '--trace-dir');
    assert.deepEqual(environment.traces.included, ['0001-a', '0002-b']);
    assert.equal(environment.traces.omitted, 1);
    assert.ok(environment.traces.redactions.some((item) => item.path.endsWith('01-client-req.json')));

    // Switch snapshot: booleans/enums only, no token-named variable, no path-shaped value.
    assert.equal(environment.switches.WINDSURFAPI_TRACE, '1');
    assert.equal(environment.switches.DEVIN_CONNECT, '1');
    assert.equal(environment.switches.CASCADE_MODE, 'native');
    assert.equal(environment.switches.WINDSURFAPI_FAKE_TOKEN, undefined);
    assert.equal(environment.switches.WINDSURFAPI_TRACE_DIR, undefined);
    for (const [name, value] of Object.entries(environment.switches)) {
      assert.match(name, /^(WINDSURFAPI|DEVIN|CASCADE)_/);
      assert.match(value, /^(?:0|1|true|false|on|off|yes|no|[a-z][a-z0-9_-]{0,23})$/);
    }
    assert.ok(!JSON.stringify(environment).includes(PLANTED_TOKEN));
  });

  it('manifest.json lists every archived file with a matching sha256', () => {
    const sidecarPath = zipPath.replace(/\.zip$/, '.manifest.json');
    assert.ok(existsSync(sidecarPath), 'a sidecar manifest is written next to the zip');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    assert.deepEqual(sidecar, manifest, 'sidecar and in-zip manifest are the same document');

    assert.equal(manifest.scan.findings, 0);
    assert.equal(manifest.files.length, zipEntries.size - 1, 'every entry except manifest.json is listed');
    for (const file of manifest.files) {
      const entry = zipEntries.get(file.path);
      assert.ok(entry, `manifest lists ${file.path}, which exists in the zip`);
      assert.equal(entry.data.length, file.bytes, `${file.path} byte count`);
      assert.equal(sha256(entry.data), file.sha256, `${file.path} sha256 matches stored bytes`);
    }
    assert.ok(!manifest.files.some((file) => file.path === 'manifest.json'), 'manifest does not list itself');
  });

  it('preserves the binary upstream leg byte-for-byte', () => {
    const entry = zipEntries.get('traces/0001-a/03-upstream-req.bin');
    assert.ok(entry, 'binary leg is present');
    assert.equal(entry.method, 0, 'stored (not compressed), so bytes are identical');
    assert.ok(entry.data.equals(BINARY_LEG), 'binary leg bytes are unchanged');
  });

  it('refuses to package when the shared secret rules match, and writes nothing', () => {
    const refusalRoot = mkdtempSync(join(tmpdir(), 'windsurfapi-support-refuse-'));
    try {
      const traceDir = join(refusalRoot, 'trace');
      const refusalOut = join(refusalRoot, 'out');
      mkdirSync(refusalOut, { recursive: true });
      writeTraceFile(refusalRoot, '0003-c', '02-routing.json', `${JSON.stringify({ note: PLANTED_TOKEN })}\n`);

      const result = runBundle(['--trace-dir', traceDir, '--out', refusalOut, '--traces', '3']);
      assert.equal(result.status, 1, `expected the secret gate to refuse:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /02-routing\.json:1 openai-api-key/);
      assert.match(result.stderr, /refusing to package/);
      assert.deepEqual(readdirSync(refusalOut), [], 'no zip and no manifest are written on refusal');
      assert.ok(!result.stderr.includes(PLANTED_TOKEN), 'the finding is reported without echoing the secret');
      assert.ok(!result.stdout.includes(PLANTED_TOKEN));
    } finally {
      rmSync(refusalRoot, { recursive: true, force: true });
    }
  });
});

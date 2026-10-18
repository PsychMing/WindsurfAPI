// The startup workspace reset must derive its db directory from DATA_DIR.
// A hardcoded /opt/windsurf/data/db silently creates a root-owned path on
// every non-/opt deployment (Windows, macOS, Docker with /data) and leaves the
// real data dir without its db folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('index.js resetWorkspace uses config.dataDir, not a hardcoded /opt path', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\/opt\/windsurf\/data/);
  assert.match(src, /join\(config\.dataDir, 'db'\)/);
});

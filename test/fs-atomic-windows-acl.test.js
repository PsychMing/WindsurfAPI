// SEC-03 (audit 2026-10-22): Windows `mode: 0o600` is a no-op — accounts.json
// (cleartext upstream tokens) and the packaged first-run .env kept inherited
// `Users:(RX)` / `Authenticated Users:(M)` ACEs. The fix is a best-effort
// icacls pass after the write: never throw (the bytes are already durable),
// but warn loudly when the restriction fails.
//
// These pin the platform switch (POSIX must be a true no-op), the exact icacls
// contract, the warn-on-failure path, and — on Windows — that a real run
// leaves no inherited ACE behind.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restrictFileToOwnerSync } from '../src/fs-atomic.js';

describe('restrictFileToOwnerSync', () => {
  it('is a no-op on non-Windows platforms', () => {
    let called = false;
    const result = restrictFileToOwnerSync('C:/whatever/accounts.json', {
      platform: 'linux',
      run: () => { called = true; },
    });
    assert.deepEqual(result, { applied: false, reason: 'not-windows' });
    assert.equal(called, false, 'POSIX must not shell out to icacls');
  });

  it('drops inheritance and grants only the current user on Windows', () => {
    const calls = [];
    const result = restrictFileToOwnerSync('C:\\data\\accounts.json', {
      platform: 'win32',
      run: (...args) => { calls.push(args); },
      resolveUser: () => 'DWGX\\operator',
    });
    assert.equal(result.applied, true);
    assert.deepEqual(calls, [[
      'icacls',
      ['C:\\data\\accounts.json', '/inheritance:r', '/grant:r', 'DWGX\\operator:(F)'],
      { stdio: 'ignore', windowsHide: true },
    ]]);
  });

  it('warns once per path+reason and never throws when icacls fails', () => {
    const warnings = [];
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    const options = {
      platform: 'win32',
      run: () => { throw failure; },
      warn: (message) => warnings.push(message),
      resolveUser: () => 'DWGX\\operator',
    };
    const first = restrictFileToOwnerSync('C:\\data\\acl-warn-probe.json', options);
    const second = restrictFileToOwnerSync('C:\\data\\acl-warn-probe.json', options);
    assert.deepEqual(first, { applied: false, reason: 'icacls-failed', error: 'denied' });
    assert.deepEqual(second, first);
    assert.equal(warnings.length, 1, 'repeated saves must not flood the log');
    assert.match(warnings[0], /could not restrict permissions/);
    assert.match(warnings[0], /inherited Users\/Authenticated Users access may remain/);
  });

  it('warns and reports no-user when the account name cannot be resolved', () => {
    const warnings = [];
    const result = restrictFileToOwnerSync('C:\\data\\accounts.json', {
      platform: 'win32',
      run: () => { throw new Error('must not run'); },
      warn: (message) => warnings.push(message),
      resolveUser: () => { throw new Error('no passwd entry'); },
    });
    assert.deepEqual(result, { applied: false, reason: 'no-user' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cannot resolve the current Windows user/);
  });

  it('a real icacls run removes inherited ACEs (Windows only)', { skip: process.platform !== 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-acl-'));
    try {
      const file = join(dir, 'secret.json');
      writeFileSync(file, '{}');
      const result = restrictFileToOwnerSync(file);
      assert.equal(result.applied, true, JSON.stringify(result));
      const acl = execFileSync('icacls', [file], { encoding: 'utf8' });
      assert.doesNotMatch(acl, /\(I\)/, `inherited ACEs still present:\n${acl}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saving accounts.json applies the owner-only ACL (Windows only)', { skip: process.platform !== 'win32' }, async () => {
    const { config } = await import('../src/config.js');
    const { addAccountByKey, removeAccount, saveAccountsSync } = await import('../src/auth.js');
    const account = addAccountByKey(`devin-session-token$acl-wiring-${Date.now()}`, 'acl-wiring');
    try {
      saveAccountsSync();
      const file = join(config.sharedDataDir || config.dataDir, 'accounts.json');
      const acl = execFileSync('icacls', [file], { encoding: 'utf8' });
      assert.doesNotMatch(acl, /\(I\)/, `accounts.json kept inherited ACEs:\n${acl}`);
    } finally {
      removeAccount(account.id);
    }
  });
});

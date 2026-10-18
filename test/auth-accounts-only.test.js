// PR #194 — per-instance account isolation. Multi-port deployments share one
// accounts.json; WAPI_ACCOUNTS_ONLY must filter by email or account id, be
// case-insensitive, and fail closed for a non-blank value with no tokens.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountsOnlyFilter, accountAllowedByFilter } from '../src/auth.js';

describe('WAPI_ACCOUNTS_ONLY', () => {
  it('is disabled when unset or blank', () => {
    assert.equal(accountsOnlyFilter({}), null);
    assert.equal(accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: '' }), null);
    assert.equal(accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: '   ' }), null);
  });

  it('parses a comma-separated list case-insensitively', () => {
    const filter = accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: ' A@Example.com, 1234abcd ,B@example.com ' });
    assert.deepEqual([...filter], ['a@example.com', '1234abcd', 'b@example.com']);
  });

  it('fails closed for a non-blank value with no tokens', () => {
    const filter = accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: ' , , ' });
    assert.ok(filter instanceof Set);
    assert.equal(filter.size, 0);
    assert.equal(accountAllowedByFilter({ email: 'a@example.com', id: '1234abcd' }, filter), false);
  });

  it('matches email or account id, case-insensitively', () => {
    const filter = accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: 'a@example.com,1234abcd' });
    assert.equal(accountAllowedByFilter({ email: 'A@EXAMPLE.COM', id: 'ffff' }, filter), true);
    assert.equal(accountAllowedByFilter({ email: 'other@example.com', id: '1234ABCD' }, filter), true);
    assert.equal(accountAllowedByFilter({ email: 'other@example.com', id: 'ffff' }, filter), false);
  });

  it('allows every account when the filter is null', () => {
    assert.equal(accountAllowedByFilter({ email: 'a@example.com', id: '1234' }, null), true);
    assert.equal(accountAllowedByFilter({}, null), true);
  });

  it('does not match an empty email or id against an empty filter token', () => {
    const filter = new Set(['']);
    assert.equal(accountAllowedByFilter({ email: '', id: '' }, filter), false);
  });
});

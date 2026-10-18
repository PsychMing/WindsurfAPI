import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getBillingUsage } from '../src/devin-backend.js';

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}
function errorResponse(status) {
  return { ok: false, status, json: async () => ({}) };
}

describe('devin backend billing usage', () => {
  it('resolves the org through GET current-membership, never post-auth', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization });
      if (url.endsWith('/users/current-membership')) return jsonResponse({ org: { org_id: 'org-test' } });
      if (url.endsWith('/billing/quota/usage')) return jsonResponse({ daily_percentage: 3 });
      if (url.endsWith('/billing/status')) return jsonResponse({ plan_slug: 'pro' });
      if (url.includes('/billing/usage/daily-usage')) return jsonResponse({ total: 0, days: [] });
      throw new Error(`unexpected ${url}`);
    };

    const out = await getBillingUsage({ baseUrl: 'https://app.devin.ai/api', token: 'tok' }, { fetchImpl });
    assert.equal(out.orgId, undefined);
    assert.equal(out.quota.daily_percentage, 3);
    assert.equal(out.status.plan_slug, 'pro');
    assert.equal(calls.length, 4);
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls[0].url.endsWith('/users/current-membership'));
    assert.ok(calls.every((c) => c.method === 'GET'));
    assert.ok(calls.every((c) => !c.url.includes('/users/post-auth')));
    assert.ok(calls[1].url.endsWith('/org-test/billing/quota/usage'));
    assert.ok(calls[2].url.endsWith('/org-test/billing/status'));
    assert.ok(calls[3].url.includes('/org-test/billing/usage/daily-usage?cycle=current&view=sessions'));
    assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
  });

  it('skips org resolution when orgId is already known', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith('/billing/quota/usage')) return jsonResponse({});
      if (url.endsWith('/billing/status')) return jsonResponse({});
      return jsonResponse({ days: [] });
    };
    const out = await getBillingUsage({ baseUrl: 'https://app.devin.ai/api', token: 'tok', orgId: 'org-known' }, { fetchImpl });
    assert.equal(out.orgId, undefined);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((url) => url.includes('/org-known/')));
  });

  it('falls back to GET /organizations and picks the primary org', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith('/users/current-membership')) return errorResponse(404);
      if (url.endsWith('/organizations')) return jsonResponse([
        { org_id: 'org-a' },
        { org_id: 'org-b', is_primary_org: true },
      ]);
      if (url.includes('/org-b/billing/')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    };
    const out = await getBillingUsage({ baseUrl: 'https://app.devin.ai/api', token: 'tok' }, { fetchImpl });
    assert.equal(out.orgId, undefined);
    assert.equal(calls.length, 5);
    assert.ok(calls.some((url) => url.endsWith('/organizations')));
    assert.ok(calls.slice(-3).every((url) => url.includes('/org-b/')));
  });

  it('rejects when neither GET endpoint returns an org id', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/users/current-membership')) return errorResponse(404);
      if (url.endsWith('/organizations')) return jsonResponse([]);
      throw new Error(`unexpected ${url}`);
    };
    await assert.rejects(
      getBillingUsage({ baseUrl: 'https://app.devin.ai/api', token: 'tok' }, { fetchImpl }),
      /did not return an org id/,
    );
  });

  it('does not fall back when the token is rejected', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return errorResponse(401);
    };
    await assert.rejects(
      getBillingUsage({ baseUrl: 'https://app.devin.ai/api', token: 'tok' }, { fetchImpl }),
      /failed: 401/,
    );
    assert.equal(calls.length, 1);
  });
});

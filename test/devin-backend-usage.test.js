import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getBillingUsage } from '../src/devin-backend.js';

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

describe('devin backend billing usage', () => {
  it('derives org then reads quota, status and daily usage', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization });
      if (url.endsWith('/users/post-auth')) return jsonResponse({ org_id: 'org-test' });
      if (url.endsWith('/billing/quota/usage')) return jsonResponse({ daily_percentage: 3 });
      if (url.endsWith('/billing/status')) return jsonResponse({ plan_slug: 'pro' });
      if (url.includes('/billing/usage/daily-usage')) return jsonResponse({ total: 0, days: [] });
      throw new Error(`unexpected ${url}`);
    };

    const out = await getBillingUsage({ baseUrl: 'https://app.devin.ai/api', token: 'tok' }, { fetchImpl });
    assert.equal(out.orgId, 'org-test');
    assert.equal(out.quota.daily_percentage, 3);
    assert.equal(out.status.plan_slug, 'pro');
    assert.equal(calls.length, 4);
    assert.ok(calls[0].url.endsWith('/users/post-auth'));
    assert.ok(calls[1].url.endsWith('/org-test/billing/quota/usage'));
    assert.ok(calls[2].url.endsWith('/org-test/billing/status'));
    assert.ok(calls[3].url.includes('/org-test/billing/usage/daily-usage?cycle=current&view=sessions'));
    assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
  });

  it('skips post-auth when orgId is already known', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith('/billing/quota/usage')) return jsonResponse({});
      if (url.endsWith('/billing/status')) return jsonResponse({});
      return jsonResponse({ days: [] });
    };
    const out = await getBillingUsage({ baseUrl: 'https://app.devin.ai/api', token: 'tok', orgId: 'org-known' }, { fetchImpl });
    assert.equal(out.orgId, 'org-known');
    assert.equal(calls.length, 3);
    assert.ok(calls.every((url) => url.includes('/org-known/')));
  });

  it('rejects a post-auth response without org_id', async () => {
    const fetchImpl = async () => jsonResponse({});
    await assert.rejects(
      getBillingUsage({ baseUrl: 'https://app.devin.ai/api', token: 'tok' }, { fetchImpl }),
      /did not return org_id/,
    );
  });
});

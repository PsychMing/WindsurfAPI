/**
 * Smoke-matrix family: acu.
 *
 * GET /dashboard/api/usage/orgs is the Q3 org-scoped ACU panel: it resolves
 * every active Devin session-token account to its org, reads the ledger ONCE
 * per org (so two accounts in one org are never double-counted) and returns a
 * hash-only org handle. The failure contract is per-org: one org that answers
 * must not be discarded because a second org failed.
 */

const ORG_REF_RE = /^orgref-[0-9a-f]{12}$/;
const ACCOUNT_REF_RE = /^acct-[0-9a-f]{8}$/;

function jsonReply(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(json),
  };
}

export function registerAcuFlows(ctx) {
  const { http, requireThat, addFlow, MATRIX, deps, SMOKE } = ctx;

  // ─── acu ─────────────────────────────────────────────────────────────
  addFlow('acu', 'acu.orgs-panel', async () => {
    const r = await http('GET', '/dashboard/api/usage/orgs?refresh=1');
    requireThat(r.status === 200, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json?.ok === true, `ok ${r.json?.ok} error ${r.json?.error || '?'}`);
    requireThat(Array.isArray(r.json.orgs), 'orgs array missing');
    requireThat(r.json.orgs.length === 1, `expected one org for the shared fixture, saw ${r.json.orgs.length}`);
    requireThat(r.json.accountsScanned >= 2, `accountsScanned ${r.json.accountsScanned}`);
    requireThat(r.json.truncated === false, 'candidate list truncated');
    requireThat(r.json.unresolvedAccounts === 0, `unresolvedAccounts ${r.json.unresolvedAccounts}`);

    const org = r.json.orgs[0];
    requireThat(org.ok === true, `org error ${org.error || '?'}`);
    requireThat(ORG_REF_RE.test(String(org.orgRef)), `orgRef ${org.orgRef}`);
    requireThat(Array.isArray(org.accounts) && org.accounts.length >= 2, `org accounts ${org.accounts?.length}`);
    requireThat(org.accounts.length === r.json.accountsScanned, 'accounts were dropped during grouping');
    requireThat(org.accounts.every((a) => typeof a.id === 'string' && ACCOUNT_REF_RE.test(String(a.ref))), 'org account refs are not hashed');
    requireThat(org.partial === false, `org partial ${org.partial} (${JSON.stringify(org.sources)})`);
    requireThat(org.plan === 'pro', `plan ${org.plan}`);
    requireThat(org.availableCredits === 1234, `availableCredits ${org.availableCredits}`);
    requireThat(org.quota?.dailyPercentage === 42.5, `dailyPercentage ${org.quota?.dailyPercentage}`);
    requireThat(org.limits?.maxAcuLimit === 100, `maxAcuLimit ${org.limits?.maxAcuLimit}`);
    requireThat(org.cycle?.total === 5, `cycle.total ${org.cycle?.total}`);

    const derived = org.derived || {};
    requireThat(derived.acuLimit?.value === 100 && derived.acuLimit?.known === true, `derived.acuLimit ${JSON.stringify(derived.acuLimit)}`);
    requireThat(derived.acuLimit?.unlimited === false, 'finite limit reported as unlimited');
    requireThat(derived.used?.value === 5 && derived.used?.known === true, `derived.used ${JSON.stringify(derived.used)}`);
    requireThat(derived.remaining?.value === 95, `derived.remaining ${JSON.stringify(derived.remaining)}`);
    requireThat(derived.remaining?.derived === true && derived.remaining?.over === false, 'remaining is not a clean derived value');
    requireThat(derived.latestDay?.date === '2026-10-22' && derived.latestDay?.amount === 5, `latestDay ${JSON.stringify(derived.latestDay)}`);

    for (const source of ['quota', 'status', 'limits', 'daily']) {
      requireThat(org.sources?.[source]?.ok === true, `source ${source} not ok: ${JSON.stringify(org.sources?.[source])}`);
    }

    // Hash-only: neither the raw org id nor any token may reach the browser.
    requireThat(!r.text.includes(SMOKE.orgId), 'raw org id leaked into the ACU payload');
    requireThat(!r.text.includes(MATRIX.sessionTokenPassword), 'session token leaked into the ACU payload');
    requireThat(!r.text.includes(MATRIX.loginImportToken), 'imported token leaked into the ACU payload');

    // Panel wiring: the section that renders this payload must exist, and the
    // ACU labels must be translated (not an untranslated English fallback).
    const html = await http('GET', '/dashboard', { auth: 'none' });
    requireThat(html.status === 200, `dashboard status ${html.status}`);
    requireThat(html.text.includes('id="usage-content"'), 'ACU panel body marker missing');
    requireThat(html.text.includes('id="usage-org-bar"'), 'ACU org selector marker missing');
    const en = await http('GET', '/dashboard/i18n/en.json', { auth: 'none' });
    const zh = await http('GET', '/dashboard/i18n/zh-CN.json', { auth: 'none' });
    requireThat(ctx.readPath(en.json, 'usage.cards.limit') === 'ACU limit', 'usage.cards.limit en label drifted');
    requireThat(typeof ctx.readPath(zh.json, 'usage.cards.limit') === 'string' && ctx.readPath(zh.json, 'usage.cards.limit') !== 'ACU limit', 'usage.cards.limit is untranslated in zh-CN');

    return `${org.accounts.length} accounts → 1 org, ${derived.used.value}/${derived.acuLimit.value} ACU`;
  });

  addFlow('acu', 'acu.orgs-per-org-failure', async () => {
    // Route one pooled token to a SECOND org whose ledger answers 403. The
    // aggregator must keep the healthy org and report the failed one per-org.
    const otherToken = MATRIX.loginImportTokenDeep;
    const original = deps.fetchImpl;
    const twoOrgFetch = async (url, init) => {
      const auth = String(init?.headers?.Authorization || init?.headers?.authorization || '');
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      if (url.includes('/users/current-membership') && token === otherToken) {
        return jsonReply({ org: { org_id: 'org-smoke-two' } });
      }
      if (url.includes('org-smoke-two')) return jsonReply({ error: 'forbidden' }, 403);
      return original(url, init);
    };

    deps.installFetch(twoOrgFetch);
    try {
      const r = await http('GET', '/dashboard/api/usage/orgs?refresh=1');
      requireThat(r.status === 200, `status ${r.status}`);
      requireThat(r.json?.ok === true, `top-level ok ${r.json?.ok} error ${r.json?.error || '?'}`);
      requireThat(r.json.orgs.length === 2, `expected two orgs, saw ${r.json.orgs.length}`);
      requireThat(r.json.unresolvedAccounts === 0, `unresolvedAccounts ${r.json.unresolvedAccounts}`);
      requireThat(r.json.accountsScanned === r.json.orgs.reduce((n, org) => n + org.accounts.length, 0), 'account census mismatch across orgs');

      const healthy = r.json.orgs.find((org) => org.ok === true);
      const failed = r.json.orgs.find((org) => org.ok === false);
      requireThat(!!healthy, 'the healthy org was discarded when a sibling failed');
      requireThat(!!failed, 'the failing org was silently dropped');
      requireThat(healthy.accounts.length >= 1, 'healthy org lost its accounts');
      requireThat(failed.accounts.length === 1, `failed org accounts ${failed.accounts.length}`);
      requireThat(failed.error === 'forbidden', `failed org error ${failed.error}`);
      requireThat(failed.httpStatus === 403, `failed org httpStatus ${failed.httpStatus}`);
      requireThat(healthy.orgRef !== failed.orgRef, 'two orgs share one hash handle');
      requireThat(ORG_REF_RE.test(healthy.orgRef) && ORG_REF_RE.test(failed.orgRef), 'org refs are not hash handles');
      requireThat(!r.text.includes('org-smoke-two'), 'raw second-org id leaked into the payload');
    } finally {
      deps.installFetch(original);
    }

    // Prove the failure left no sticky state.
    ctx.deps.resetReadCache();
    const recovered = await http('GET', '/dashboard/api/usage/orgs?refresh=1');
    requireThat(recovered.status === 200 && recovered.json?.ok === true, `recovery status ${recovered.status}`);
    requireThat(recovered.json.orgs.length === 1, `recovery still reports ${recovered.json.orgs.length} orgs`);
    requireThat(recovered.json.orgs[0].ok === true, 'recovery org is not healthy');
    return 'per-org 403 isolated; healthy org rendered; no sticky failure';
  });
}

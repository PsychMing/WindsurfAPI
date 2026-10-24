import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectSelector, FREE_TIER_SELECTOR } from '../src/devin-connect-models.js';

const SAVED_CONNECT_TOKEN = process.env.DEVIN_CONNECT_TOKEN;
const SAVED_WINDSURF_API_KEY = process.env.WINDSURF_API_KEY;

beforeEach(() => {
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
});

afterEach(() => {
  if (SAVED_CONNECT_TOKEN === undefined) delete process.env.DEVIN_CONNECT_TOKEN;
  else process.env.DEVIN_CONNECT_TOKEN = SAVED_CONNECT_TOKEN;
  if (SAVED_WINDSURF_API_KEY === undefined) delete process.env.WINDSURF_API_KEY;
  else process.env.WINDSURF_API_KEY = SAVED_WINDSURF_API_KEY;
});

describe('resolveConnectSelector', () => {
  it('resolves the free-tier swe selector (dash and dot forms)', () => {
    assert.deepEqual(resolveConnectSelector('swe-1-6-slow'), { selector: 'swe-1-6-slow', mapped: true });
    assert.deepEqual(resolveConnectSelector('swe-1.6-slow'), { selector: 'swe-1-6-slow', mapped: true });
  });

  it('maps swe-2 _lookup aliases onto catalog selectors', () => {
    // Same names models.js _lookup accepts. Without these SELECTOR_MAP rows,
    // DEVIN_CONNECT=1 + STRICT_MODEL=1 400s them even though resolveModel succeeds.
    const cases = [
      ['swe-2', 'swe-2-medium'],
      ['swe-2.0', 'swe-2-medium'],
      ['swe-2-0', 'swe-2-medium'],
      ['swe2', 'swe-2-medium'],
      ['swe-2-medium', 'swe-2-medium'],
      ['swe-2-high', 'swe-2-high'],
      ['swe-2-max', 'swe-2-max'],
      ['swe-2.0-medium', 'swe-2-medium'],
      ['swe-2.0-high', 'swe-2-high'],
      ['swe-2.0-max', 'swe-2-max'],
    ];
    for (const [name, selector] of cases) {
      assert.deepEqual(resolveConnectSelector(name), { selector, mapped: true }, name);
    }
  });

  it('maps the dashed swe-2.0 effort spellings onto their swe-2 tiers', () => {
    // Live-catalog probe (2026-10-25): `swe-2-0-medium` / `swe-2-0-high` /
    // `swe-2-0-max` were the ONLY swe-2 spellings missing from SELECTOR_MAP —
    // they resolved to {selector:null, mapped:false} against a live catalog and
    // to the swe-1-6-slow degrade target against the frozen snapshot, while the
    // unsuffixed `swe-2-0` row and the dotted `swe-2.0-{medium,high,max}` rows
    // worked. Same model family, four spellings, one of them silently free-tier.
    // Targets are verified present in src/data/devin-catalog-snapshot.json.
    const cases = [
      ['swe-2-0-medium', 'swe-2-medium'],
      ['swe-2-0-high', 'swe-2-high'],
      ['swe-2-0-max', 'swe-2-max'],
    ];
    for (const [name, selector] of cases) {
      assert.deepEqual(resolveConnectSelector(name), { selector, mapped: true }, name);
    }
  });

  it('maps claude friendly names to their captured upstream selectors', () => {
    assert.equal(resolveConnectSelector('claude-opus-4.8').selector, 'claude-opus-4-8-medium');
    // Dashed bare form is a real catalog selector (base model) → resolves to itself;
    // the dotted family alias keeps the curated -thinking default.
    assert.equal(resolveConnectSelector('claude-sonnet-4-6').selector, 'claude-sonnet-4-6');
    assert.equal(resolveConnectSelector('claude-sonnet-4.6').selector, 'claude-sonnet-4-6-thinking');
    assert.equal(resolveConnectSelector('claude-sonnet-4.5').selector, 'MODEL_PRIVATE_2');
    assert.equal(resolveConnectSelector('claude-haiku-4-5').selector, 'MODEL_PRIVATE_11');
  });

  it('maps gpt and gemini families', () => {
    assert.equal(resolveConnectSelector('gpt-5-2-high').selector, 'MODEL_GPT_5_2_HIGH');
    assert.equal(resolveConnectSelector('gemini-3-flash').selector, 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM');
  });

  it('is case-insensitive and strips a provider prefix', () => {
    assert.equal(resolveConnectSelector('Claude-Opus-4.8').selector, 'claude-opus-4-8-medium');
    assert.equal(resolveConnectSelector('anthropic/claude-sonnet-4-5').selector, 'MODEL_PRIVATE_2');
  });

  it('passes enum-form selectors through verbatim', () => {
    assert.deepEqual(resolveConnectSelector('MODEL_CLAUDE_4_5_OPUS_THINKING'),
      { selector: 'MODEL_CLAUDE_4_5_OPUS_THINKING', mapped: true });
  });

  it('degrades unknown names to the free-tier selector (mapped:false)', () => {
    assert.deepEqual(resolveConnectSelector('gpt-9-ultra'), { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector(''), { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector(null), { selector: FREE_TIER_SELECTOR, mapped: false });
  });

  it('resolves a dotted dash-form that normalizes to a real catalog selector', () => {
    // Regression: "gpt-5.5-medium" → norm "gpt-5-5-medium" IS a catalog selector
    // but not a SELECTOR_MAP alias. Before the norm→catalog check it silently
    // degraded to the free tier (mapped:false); it must now resolve mapped:true.
    const r = resolveConnectSelector('gpt-5.5-medium');
    assert.equal(r.selector, 'gpt-5-5-medium');
    assert.equal(r.mapped, true);
  });
});

describe('resolveConnectSelector — live catalog (audit 2026-07-12 snapshot staleness)', () => {
  // The committed snapshot never live-synced, so selectors the upstream added
  // after it was captured (proven on a live account 2026-07-12: qwen-3, glm-5,
  // kimi-k2.5, deepseek-v3, minimax-*) were absent from CATALOG_SELECTORS and
  // got mapped:false → 400'd by the strict gate despite being runnable. The live
  // catalog set (populated from GetCliModelConfigs) becomes authoritative after
  // every active contributor has a successful sync; the snapshot remains the
  // cold-start and partial-sync fallback.
  const STALE = ['qwen-3', 'glm-5', 'kimi-k2.5', 'deepseek-v3'];

  it('cold start (no live sync): a genuinely-runnable-but-unsnapshotted selector is mapped:false', async () => {
    // Fresh import so _liveSelectors starts empty (module-level Set).
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-a`);
    assert.equal(m.hasLiveCatalog(), false, 'no live sync yet');
    // qwen-3 is not in the frozen snapshot → without live catalog it degrades.
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, false);
  });

  it('after live sync: the same selectors resolve mapped:true to themselves', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-b`);
    // Simulate a GetCliModelConfigs sync feeding the decoded catalog shape.
    m.setLiveCatalogSelectors(STALE.map(s => ({ selector: s })));
    assert.equal(m.hasLiveCatalog(), true);
    for (const s of STALE) {
      const r = m.resolveConnectSelector(s);
      assert.equal(r.mapped, true, `${s} must be recognized after live sync`);
      assert.equal(r.selector, s, `${s} resolves to itself`);
    }
  });

  it('live sync recognizes the canonical selector but does NOT pass a family alias through raw (ultracode fix 2026-07-12)', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-c`);
    // Real regression shape: <family>-medium is the upstream-accepted selector;
    // the bare family name is its alias and is NOT in the hand-maintained
    // SELECTOR_MAP. (Use a future family so this guard stays valid as the map
    // grows; gpt-5.6-sol is mapped now.)
    m.setLiveCatalogSelectors([{ selector: 'gpt-7-future-medium', alias: 'gpt-7-future' }]);
    // The canonical full selector IS recognized from the live catalog.
    assert.equal(m.resolveConnectSelector('gpt-7-future-medium').mapped, true);
    // The family alias must NOT resolve mapped:true off the live set — folding it
    // in made the gateway pass the bare family form to upstream #21 → UPSTREAM_INTERNAL
    // (burns the account). Aliases are the SELECTOR_MAP's job; an unknown one fails
    // closed (degrades to free / 400 under strict), it does NOT pass through raw.
    const r = m.resolveConnectSelector('gpt-7-future');
    assert.equal(r.mapped, false, 'family alias not in SELECTOR_MAP must NOT be treated as a runnable selector');
    assert.notEqual(r.selector, 'gpt-7-future', 'must never emit the bare family alias as the upstream selector');
  });

  it('a known SELECTOR_MAP alias still resolves correctly (regression guard)', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-c2`);
    m.setLiveCatalogSelectors([{ selector: 'glm-5-2', alias: 'glm-5.2' }]);
    // glm-5.2 is in the hand-maintained SELECTOR_MAP → still resolves to glm-5-2,
    // independent of the (now removed) alias fold.
    assert.equal(m.resolveConnectSelector('glm-5-2').mapped, true);
    assert.equal(m.resolveConnectSelector('glm-5.2').selector, 'glm-5-2');
  });

  it('resolves the dashed glm-5-1 spelling onto the same selector as glm-5.1', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-glm51`);
    // Live catalog in which the only GLM row is glm-5-2 — the shape a real account
    // reports. Before this fix the map carried `glm-5.1` but NOT `glm-5-1`, so the
    // dashed spelling missed every map lookup, was absent from the live set, and the
    // authoritative catalog left no degrade target → {selector:null, mapped:false},
    // which the handler answers with 400 model_not_found. Dotted worked, dashed did
    // not, for the same model.
    m.setLiveCatalogSelectors([{ selector: 'glm-5-2' }]);
    assert.deepEqual(m.resolveConnectSelector('glm-5-1'), { selector: 'glm-5-2', mapped: true },
      'dashed glm-5-1 must resolve to the live glm-5-2 selector, not fail model_not_found');
    assert.deepEqual(m.resolveConnectSelector('glm-5.1'), { selector: 'glm-5-2', mapped: true },
      'dotted glm-5.1 keeps resolving to the same selector');
  });

  it('retires a snapshot alias when its target is absent from a complete live catalog', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-c3`);
    m.setLiveCatalogSelectors([
      { selector: 'claude-opus-4-8-medium', alias: 'claude-opus-4.8' },
    ]);

    assert.equal(m.resolveConnectSelector('claude-opus-4.8').mapped, true,
      'precondition: an alias targeting a live selector remains valid');
    const retired = m.resolveConnectSelector('gpt-5.5', { warnOnFallback: false });
    // #258 residual: this used to degrade to FREE_TIER_SELECTOR. On a complete
    // live sync that selector is not callable either (it is absent from the live
    // catalog and 502s as "quota exhausted"), so "retired" must mean RETIRED —
    // null forces the handler to answer model_not_found instead of routing the
    // caller to a dead model and reporting its quota error as if it were theirs.
    assert.deepEqual(retired, { selector: null, mapped: false },
      'chat preflight must not keep a snapshot-only alias routable after complete live sync, '
      + 'and must not redirect it to a selector the live catalog proved absent');
  });

  it('keeps snapshot aliases during an explicitly incomplete mixed-pool sync', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-partial`);
    m.setLiveCatalogSelectors([
      { selector: 'claude-opus-4-8-medium' },
    ], { includeSnapshotFallback: true });

    assert.deepEqual(
      m.resolveConnectSelector('gpt-5.5', { warnOnFallback: false }),
      { selector: 'gpt-5-5-low', mapped: true },
      'an account without LKG rows still contributes the frozen snapshot fallback',
    );
  });

  it('keeps snapshot aliases for the process env-token fallback beside live rows', async () => {
    const savedToken = process.env.DEVIN_CONNECT_TOKEN;
    const savedKey = process.env.WINDSURF_API_KEY;
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-env-token`);
    try {
      delete process.env.WINDSURF_API_KEY;
      process.env.DEVIN_CONNECT_TOKEN = 'env-token-fallback-test';
      m.setLiveCatalogSelectors([{ selector: 'claude-opus-4-8-medium' }]);
      assert.deepEqual(
        m.resolveConnectSelector('gpt-5.5', { warnOnFallback: false }),
        { selector: 'gpt-5-5-low', mapped: true },
      );
    } finally {
      if (savedToken === undefined) delete process.env.DEVIN_CONNECT_TOKEN;
      else process.env.DEVIN_CONNECT_TOKEN = savedToken;
      if (savedKey === undefined) delete process.env.WINDSURF_API_KEY;
      else process.env.WINDSURF_API_KEY = savedKey;
    }
  });

  it('keeps catalog-independent synthetic selectors valid after live sync', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-synthetic`);
    m.setLiveCatalogSelectors([{ selector: 'claude-opus-4-8-medium' }]);

    assert.deepEqual(
      m.resolveConnectSelector('subagent-default'),
      { selector: 'subagent-default', mapped: true },
    );
  });

  it('a bad/empty sync never blanks out a good live set', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-d`);
    m.setLiveCatalogSelectors([{ selector: 'qwen-3' }]);
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, true);
    m.setLiveCatalogSelectors([]);          // empty → no-op
    m.setLiveCatalogSelectors(null);        // garbage → no-op
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, true, 'prior good set survives a bad sync');
  });

  it('normalizes string-only seam rows into the readable live catalog', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-strings`);
    m.setLiveCatalogSelectors(['  qwen-3  ', '']);

    assert.deepEqual(m.getLiveCatalog(), [{ selector: 'qwen-3' }]);
    assert.deepEqual(m.resolveConnectSelector('qwen-3'), { selector: 'qwen-3', mapped: true });
  });

  it('normalizes object selectors without dropping their catalog metadata', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-objects`);
    m.setLiveCatalogSelectors([
      { selector: '  qwen-3  ', label: 'Qwen 3', provider: 'alibaba' },
    ]);

    assert.deepEqual(m.getLiveCatalog(), [
      { selector: 'qwen-3', label: 'Qwen 3', provider: 'alibaba' },
    ]);
    assert.deepEqual(m.resolveConnectSelector('qwen-3'), { selector: 'qwen-3', mapped: true });
  });

  it('genuine junk still degrades even with a live catalog present', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-e`);
    m.setLiveCatalogSelectors([{ selector: 'qwen-3' }]);
    assert.equal(m.resolveConnectSelector('totally-fake-model-xyz').mapped, false);
  });
});

describe('resolveConnectSelector — live free fallback (#258 residual)', () => {
  // #258 residual: the static `swe-1-6-slow` degrade target is absent from a
  // synced catalog and answers with "Your daily usage quota has been exhausted",
  // so an unmapped name surfaced as a FAKE QUOTA ERROR. A degrade target has to
  // be callable, and the caller that holds live pricing data says which are.

  it('refuses the frozen fallback once a live catalog proves it absent', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb1`);
    m.setLiveCatalogSelectors([{ selector: 'swe-1-7' }, { selector: 'glm-5-2' }]);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', { warnOnFallback: false }),
      { selector: null, mapped: false },
      'no callable target: the caller must answer model_not_found, not route to a dead selector',
    );
    assert.deepEqual(
      m.resolveConnectSelector('', { warnOnFallback: false }),
      { selector: null, mapped: false },
      'the omitted-model path has the same constraint',
    );
  });

  it('degrades to a live free selector supplied by the caller', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb2`);
    m.setLiveCatalogSelectors([{ selector: 'swe-1-7' }, { selector: 'glm-5-2' }]);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', {
        warnOnFallback: false,
        freeFallback: ['glm-5-2', 'swe-1-7'],
      }),
      { selector: 'glm-5-2', mapped: false },
      'caller order is the preference order',
    );
  });

  it('skips a free selector the catalog does not expose and takes the next', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb3`);
    m.setLiveCatalogSelectors([{ selector: 'swe-1-7' }]);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', {
        warnOnFallback: false,
        // swe-2-medium is free on a promo deployment but this catalog does not
        // carry it — routing there would be the same dead-target defect.
        freeFallback: ['swe-2-medium', 'swe-1-7'],
      }),
      { selector: 'swe-1-7', mapped: false },
    );
  });

  it('a live free selector outranks the static floor on cold start', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb4`);
    assert.equal(m.hasLiveCatalog(), false);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', {
        warnOnFallback: false,
        freeFallback: ['swe-1-7'],
      }),
      { selector: 'swe-1-7', mapped: false },
    );
  });

  it('keeps the static floor while no live catalog has arrived', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb5`);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', { warnOnFallback: false }),
      { selector: 'swe-1-6-slow', mapped: false },
      'cold start: nothing has contradicted the documented floor yet, so it applies',
    );
  });
});

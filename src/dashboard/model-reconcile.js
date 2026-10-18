/**
 * P0-3 live model reconciliation.
 *
 * Pure reconciler: compares the deployment's `/v1/models` rows, the live
 * DEVIN_CONNECT catalog and the committed snapshot, then folds in the
 * account-scoped model sources (internal catalog, federation overlay, toggleable
 * agent versions, org config). Counts and keys only — raw upstream values for
 * the unverified shapes are never forwarded.
 *
 * `snapshotCount` is the committed snapshot size (233), never the older 181
 * number from an earlier capture.
 */

import { buildCatalogDiff } from './catalog-diff.js';
import {
  getLiveCatalog,
  getSnapshotSelectors,
  resolveConnectSelector,
} from '../devin-connect-models.js';
import { handleModels } from '../handlers/models.js';
import {
  TTL_MS,
  cacheKey,
  httpStatusForKind,
  readCached,
  readDevinJson,
  resolveAccount,
  resolveOrgId,
  sourceSummary,
  ReadError,
} from './devin-read.js';

const TOGGLEABLE_ROW_CAP = 50;
const DIFF_ROW_CAP = 500;
const LABEL_CAP = 20;
const LABEL_LENGTH_CAP = 80;

const TEAM_FIELDS = [
  'allowMcpServers',
  'maxUnclaimedSites',
  'allowAppDeployments',
  'allowSandboxAppDeployments',
  'allowTeamsAppDeployments',
  'maxNewSitesPerDay',
  'allowBrowserExperimentalFeatures',
  'allowCodemapSharing',
  'maxCascadeAutoExecutionLevel',
  'cascadeWebSearchEnabled',
  'allowArenaMode',
  'allowBundlingDevinCli',
  'devinTerminalAcpEnabled',
  'devinCloudAcpEnabled',
  'subagentDefaultModelUid',
];

function objectOrEmpty(value) {
  return value && typeof value === 'object' ? value : {};
}

function selectorOf(row) {
  if (typeof row === 'string') return row.trim();
  if (row && typeof row === 'object') {
    const value = row.selector || row._windsurf_id || row.id;
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

function uniqueSelectors(rows) {
  const out = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const selector = selectorOf(row);
    if (selector) out.add(selector);
  }
  return out;
}

/**
 * Deterministic toggleable-version → selector ladder. No 19-row hardcode: the
 * mapping follows the documented name transformations and asks the same resolver
 * the chat path uses.
 */
export function mapToggleableVersion(version) {
  const raw = typeof version === 'string' ? version.trim() : '';
  if (!raw) return { selector: null, mapped: false };

  const stripped = raw.replace(/^devin[-_]/, '').replace(/_/g, '-');
  const candidates = [raw];
  if (stripped && stripped !== raw) candidates.push(stripped);
  if (/^(fable|opus|sonnet|haiku)-/.test(stripped)) candidates.push(`claude-${stripped}`);
  const lightning = stripped.match(/^swe-2-lightning-(low|medium|high|max)$/);
  if (lightning) candidates.push(`swe-2-${lightning[1]}-lightning`);

  for (const candidate of candidates) {
    const resolved = resolveConnectSelector(candidate, { warnOnFallback: false });
    if (resolved?.mapped) return { selector: resolved.selector, mapped: true };
  }
  return { selector: null, mapped: false };
}

function buildToggleable(toggleable, localSelectors) {
  const versions = (Array.isArray(toggleable) ? toggleable : [])
    .map((row) => (typeof row === 'string' ? row : row?.version))
    .filter((version) => typeof version === 'string' && version.trim())
    .map((version) => version.trim());

  const all = versions.map((version) => ({ version, ...mapToggleableVersion(version) }));
  const mapped = all.filter((row) => row.mapped);
  const present = mapped.filter((row) => localSelectors.has(row.selector)).length;
  return {
    total: all.length,
    mappedCount: mapped.length,
    unmappedCount: all.length - mapped.length,
    localPresentCount: present,
    localMissingCount: mapped.length - present,
    rows: all.slice(0, TOGGLEABLE_ROW_CAP),
  };
}

function buildFedModels(fedModels, liveSelectors) {
  const raw = fedModels && typeof fedModels === 'object' ? fedModels : null;
  const tiers = objectOrEmpty(raw?.tiers);
  const models = objectOrEmpty(raw?.models);
  const helpers = Array.isArray(raw?.helpers) ? raw.helpers : [];
  const allowlist = Array.isArray(raw?.allowlist) ? raw.allowlist : null;
  const tierCount = Object.keys(tiers).length;
  const modelCount = Object.keys(models).length;
  const helperCount = helpers.length;
  const allowlistCount = allowlist ? allowlist.length : 0;
  const present = modelCount > 0 || helperCount > 0 || tierCount > 0 || allowlist !== null;

  let allowedLiveCount = null;
  let blockedLiveCount = null;
  if (present) {
    const overlay = new Set([
      ...Object.keys(models),
      ...(allowlist || []).map((value) => String(value)),
    ]);
    allowedLiveCount = liveSelectors.filter((selector) => overlay.has(selector)).length;
    blockedLiveCount = liveSelectors.length - allowedLiveCount;
  }

  return {
    present,
    modelCount,
    helperCount,
    tierCount,
    allowlistPresent: allowlist !== null,
    allowlistCount,
    allowedLiveCount,
    blockedLiveCount,
  };
}

function buildUpstreamCatalog(upstreamCatalog) {
  const raw = upstreamCatalog && typeof upstreamCatalog === 'object' ? upstreamCatalog : null;
  const groupCount = Array.isArray(raw?.groups) ? raw.groups.length : 0;
  const sectionCount = Array.isArray(raw?.sections) ? raw.sections.length : 0;
  return { empty: groupCount === 0 && sectionCount === 0, groupCount, sectionCount };
}

function buildOrgConfig(orgConfigs) {
  const raw = orgConfigs && typeof orgConfigs === 'object' ? orgConfigs : null;
  const team = objectOrEmpty(raw?.enterpriseTeamConfig);
  const control = objectOrEmpty(raw?.enterpriseControlConfig);
  const labelsRaw = Array.isArray(control.extensionModelLabels)
    ? control.extensionModelLabels
    : (Array.isArray(team.extensionModelLabels) ? team.extensionModelLabels : []);
  const labels = labelsRaw
    .slice(0, LABEL_CAP)
    .map((label) => String(label ?? '').slice(0, LABEL_LENGTH_CAP));

  const out = {
    present: !!raw && (Object.keys(team).length > 0 || Object.keys(control).length > 0),
    teamIdPresent: typeof team.teamId === 'string'
      || typeof control.teamId === 'string'
      || typeof raw?.teamId === 'string',
  };
  for (const field of TEAM_FIELDS) {
    const value = team[field] !== undefined ? team[field] : control[field];
    out[field] = value === undefined ? null : value;
  }
  out.extensionModelLabels = labels;
  return out;
}

export function buildModelReconciliation({
  local = [],
  live = [],
  snapshot = [],
  toggleable = [],
  fedModels = null,
  orgConfigs = null,
  upstreamCatalog = null,
  sources = {},
  accountId = null,
  accountRef = null,
  now = Date.now(),
} = {}) {
  const resolve = (name) => resolveConnectSelector(name, { warnOnFallback: false });
  const diff = buildCatalogDiff({ live, snapshot, resolve });
  const liveSelectors = [...uniqueSelectors(live)];
  const localSelectors = new Set();
  for (const row of Array.isArray(local) ? local : []) {
    const raw = typeof row === 'string' ? row : (row?._windsurf_id || row?.id);
    if (!raw) continue;
    const resolved = resolve(raw);
    if (resolved?.mapped) localSelectors.add(resolved.selector);
  }
  const localIds = new Set(
    (Array.isArray(local) ? local : [])
      .map((row) => (typeof row === 'string' ? row : (row?.id || row?._windsurf_id)))
      .filter(Boolean),
  );

  const degraded = Object.entries(sources || {})
    .filter(([, source]) => source?.ok === false)
    .map(([source, result]) => ({
      source,
      kind: result.error || 'upstream',
      status: result.status ?? null,
    }));

  return {
    ok: true,
    accountId,
    accountRef,
    fetchedAt: now,
    stale: Object.values(sources || {}).some((source) => source?.stale === true),
    partial: degraded.length > 0,
    synced: diff.synced,
    snapshotCount: diff.snapshotCount,
    liveCount: diff.liveCount,
    localCount: localIds.size,
    added: diff.added.slice(0, DIFF_ROW_CAP),
    missing: diff.missing.slice(0, DIFF_ROW_CAP),
    unmapped: diff.unmapped.slice(0, DIFF_ROW_CAP),
    aliases: diff.aliases.slice(0, DIFF_ROW_CAP),
    aliasCount: diff.aliasCount,
    toggleable: buildToggleable(toggleable, localSelectors),
    fedModels: buildFedModels(fedModels, liveSelectors),
    upstreamCatalog: buildUpstreamCatalog(upstreamCatalog),
    orgConfig: buildOrgConfig(orgConfigs),
    degraded,
    sources,
  };
}

export async function readModelReconciliation({ id, force = false, fetchImpl = null, now = Date.now() } = {}) {
  const account = resolveAccount(id);
  if (!account.ok) return { ok: false, error: account.error, httpStatus: account.status };

  let orgId;
  try {
    orgId = await resolveOrgId({ token: account.token, fetchImpl, force });
  } catch (err) {
    const kind = err instanceof ReadError ? err.kind : 'upstream';
    return {
      ok: false,
      accountId: account.accountId,
      accountRef: account.accountRef,
      error: kind,
      httpStatus: err?.status || httpStatusForKind(kind),
    };
  }

  const read = (name, path, orgScoped) => readCached(
    cacheKey({ accountId: account.accountId, token: account.token, name }),
    TTL_MS.models,
    () => readDevinJson({
      token: account.token,
      orgId: orgScoped ? orgId : '',
      path,
      fetchImpl,
    }),
    { force },
  );

  const [catalog, fed, toggleable, orgConfig] = await Promise.all([
    read('model-catalog', '/internal-model-catalog', false),
    read('fed-models', `/${orgId}/fed-models`, true),
    read('toggleable', '/toggleable-agent-versions', false),
    read('org-configs', '/windsurf/org-configs', false),
  ]);

  const sources = {
    catalog: sourceSummary(catalog),
    fed: sourceSummary(fed),
    toggleable: sourceSummary(toggleable),
    orgConfig: sourceSummary(orgConfig),
  };

  let local;
  try {
    local = handleModels().data;
  } catch {
    return {
      ok: false,
      accountId: account.accountId,
      accountRef: account.accountRef,
      error: 'upstream',
      httpStatus: 502,
      sources,
    };
  }

  const upstreamCatalog = catalog.value;
  const fedModels = fed.value;
  const toggleableValue = Array.isArray(toggleable.value?.toggleable_versions)
    ? toggleable.value.toggleable_versions
    : [];
  const orgConfigs = orgConfig.value;

  return buildModelReconciliation({
    local,
    live: getLiveCatalog(),
    snapshot: getSnapshotSelectors(),
    toggleable: toggleableValue,
    fedModels,
    orgConfigs,
    upstreamCatalog,
    sources,
    accountId: account.accountId,
    accountRef: account.accountRef,
    now,
  });
}

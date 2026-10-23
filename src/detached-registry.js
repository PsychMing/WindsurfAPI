// Detached Cascade turns: key → frozen snapshot, one resumer, bounded lease.
//
// P1 is LAZY: a detached turn stores the producer snapshot and nothing else.
// No pump, no settlement poll, no completed-entry replay, no live-follow
// cursor. A retry that arrives with a byte-identical body claims the entry and
// continues the normal poll loop; a retry that never arrives costs zero RPCs.
//
// Ownership is single-writer by construction:
//
//   running --claim--> claimed --release(served)--> deleted
//                          \----release(running)--> running (re-detach)
//   running --evict--> deleted
//
// `admit` freezes an entry. Nothing mutates it while it is `running`, so there
// is no read cursor to race and no byte-accounting to reconcile.
//
// The registry holds NO language-server lease. P1's brief is explicit: a
// detached entry must not pin `beginLsUse` beyond the request that produced
// it. The resume request acquires the lease for its own lifetime (and releases
// it in cascadeChat's finally); between detach and claim the LS is free to be
// reaped or evicted, and a missing/regenerated LS is a resume miss, not a leak.
//
// Dependency direction: this module may import src/cache.js (the canonical
// body key) and nothing from src/handlers/* or the conversation pool. The
// tenancy gate is supplied by the caller as `scopeTrusted` so there is exactly
// ONE authoritative implementation of it (src/handlers/chat.js hasPerUserScope)
// rather than a second, drift-prone copy.

import { createHash, randomUUID } from 'crypto';
import { cacheKey as computeCacheKey } from './cache.js';
import { cascadeTurnEnabled } from './cascade-turn.js';

export const DETACHED_TTL_MS = 120_000;
export const DETACHED_MAX_ENTRIES = 8;
export const DETACHED_MAX_PER_CALLER = 2;
export const DETACHED_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const DETACHED_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Detach is a behaviour change (network, memory, billing, shared resources)
 * and gets its own switch. It is meaningful only when the producer path owns
 * the turn state, so the producer flag is a hard prerequisite: detach with
 * `WINDSURFAPI_CASCADE_TURN` off has no snapshot to store.
 */
export function cascadeDetachEnabled(env = process.env) {
  return String(env.WINDSURFAPI_CASCADE_DETACH || '') === '1' && cascadeTurnEnabled(env);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Key for a detached turn.
 *
 * Deliberately NOT the handler's `ckey`: that is null whenever the response
 * cache is disabled or the scope is untrusted, which would silently disable
 * detach on a cache-less deployment. The body key comes from cache.js's
 * unconditional `cacheKey` (body + caller scope), and the digest covers every
 * output-affecting route decision:
 *
 *   - route: messages/gemini/responses adapters differ;
 *   - modelKey: the RESOLVED routing key, not body.model (access fallback can
 *     rewrite it, so the same body can route to a different model);
 *   - displayModel: injected into the prompt as a `[Context: …]` line;
 *   - toolPreambleTier / emulateTools: change the prompt and the parser;
 *   - native bridge options: change the upstream tool protocol;
 *   - stop: enforced locally on the replay, so a different stop is a different
 *     answer.
 *
 * `scopeTrusted` is the caller's `hasPerUserScope(callerKey)` result. A
 * falsy value returns null: an entry holds raw model output, and a cross-tenant
 * hit would be a data leak (the repo treats that as P0 for relays).
 */
export function detachedKey(body, callerKey, opts = {}) {
  if (!opts.scopeTrusted) return null;
  const scope = String(callerKey || '');
  if (!scope) return null;
  const native = opts.native || null;
  const digest = stableJson({
    route: opts.route || 'chat',
    stream: true,
    modelKey: opts.modelKey || '',
    toolPreambleTier: opts.toolPreambleTier || null,
    emulateTools: !!opts.emulateTools,
    native: native ? {
      enabled: !!native.enabled,
      allowlist: Array.isArray(native.allowlist) ? native.allowlist : null,
      environment: native.environment || '',
      additionalSteps: native.additionalSteps || null,
    } : null,
    stop: Array.isArray(opts.stop) ? opts.stop : [],
    displayModel: opts.displayModel || '',
  });
  return sha256(`detached\0${computeCacheKey(body, scope)}\0${digest}`);
}

function snapshotBytes(snapshot, pin) {
  let bytes = 1024; // fixed per-entry overhead (maps, cursor arrays)
  for (const chunk of snapshot?.chunks || []) {
    const text = typeof chunk?.text === 'string' ? chunk.text.length : 0;
    const thinking = typeof chunk?.thinking === 'string' ? chunk.thinking.length : 0;
    bytes += (text + thinking) * 2 + 64;
  }
  try {
    bytes += Buffer.byteLength(JSON.stringify(pin || {}));
  } catch {
    bytes += 0;
  }
  return bytes;
}

function zeroCounters() {
  return {
    admit: 0,
    refuse: {
      no_scope: 0,
      no_chunks: 0,
      tools: 0,
      native: 0,
      no_lease: 0,
      over_bytes: 0,
      over_entries: 0,
      draining: 0,
      not_client_gone: 0,
      no_deadline: 0,
      bad_snapshot: 0,
      busy: 0,
    },
    lookup: { hit: 0, miss: 0 },
    claim: { ok: 0, busy: 0, ttl: 0, deadline: 0, gone: 0 },
    serve: 0,
    re_detach: 0,
    evict: {
      ttl: 0, drain: 0, account_removed: 0, resume_miss: 0, capacity: 0, superseded: 0, deadline: 0,
    },
    replay_bytes: 0,
    billed_detached: 0,
  };
}

function cloneCounters(counters) {
  return {
    ...counters,
    refuse: { ...counters.refuse },
    lookup: { ...counters.lookup },
    claim: { ...counters.claim },
    evict: { ...counters.evict },
  };
}

/**
 * In-memory registry. The handler uses the module-level singleton below; tests
 * construct their own so a fake clock and a small cap cannot leak between
 * files.
 */
export class DetachedRegistry {
  constructor({
    ttlMs = DETACHED_TTL_MS,
    maxEntries = DETACHED_MAX_ENTRIES,
    maxPerCaller = DETACHED_MAX_PER_CALLER,
    maxEntryBytes = DETACHED_MAX_ENTRY_BYTES,
    maxTotalBytes = DETACHED_MAX_TOTAL_BYTES,
    timers = true,
    now = Date.now,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxPerCaller = maxPerCaller;
    this.maxEntryBytes = maxEntryBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.timers = timers;
    this.now = now;
    this.entries = new Map();
    this.totalBytes = 0;
    this.draining = false;
    this.counters = zeroCounters();
  }

  stats() {
    return {
      ...cloneCounters(this.counters),
      entries: this.entries.size,
      bytes: this.totalBytes,
      draining: this.draining,
    };
  }

  reset() {
    for (const entry of this.entries.values()) this.#clearTimer(entry);
    this.entries.clear();
    this.totalBytes = 0;
    this.draining = false;
    this.counters = zeroCounters();
  }

  #clearTimer(entry) {
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  #armTimer(entry, delayMs) {
    if (!this.timers) return;
    this.#clearTimer(entry);
    const delay = Math.max(1, delayMs);
    entry.timer = setTimeout(() => {
      const current = this.entries.get(entry.key);
      if (current === entry && entry.state === 'running') this.evict(entry.key, 'ttl');
    }, delay);
    entry.timer.unref?.();
  }

  #delete(entry, cause) {
    this.#clearTimer(entry);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    if (cause) this.counters.evict[cause] = (this.counters.evict[cause] || 0) + 1;
  }

  /** Drop expired entries without waiting on a timer. Returns the count. */
  sweepExpired(now = this.now()) {
    let evicted = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.expiresAt <= now) {
        this.#delete(entry, 'ttl');
        evicted++;
      }
    }
    return evicted;
  }

  /** Evict the oldest non-claimed entry; returns true when one was dropped. */
  #evictOldestRunning(cause, { callerKey = null } = {}) {
    let oldest = null;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'running') continue;
      if (callerKey != null && entry.callerKey !== callerKey) continue;
      if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
    }
    if (!oldest) return false;
    this.#delete(oldest, cause);
    return true;
  }

  #callerCount(callerKey) {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.callerKey === callerKey) count++;
    }
    return count;
  }

  /**
   * Freeze a detached turn.
   *
   * `pin` = { cascadeId, sessionId, lsPort, lsGeneration, accountId, modelKey,
   *           generatorOffset, deadline, startedAt }.
   *
   * Returns { token } on success or { refused: reason }. A refusal is not an
   * error: the producer simply continues its abort path.
   */
  admit({ key, callerKey, snapshot, pin, cause = 'client_gone' } = {}) {
    if (this.draining) {
      this.counters.refuse.draining++;
      return { refused: 'draining' };
    }
    if (!key || !callerKey) {
      this.counters.refuse.no_scope++;
      return { refused: 'no_scope' };
    }
    if (cause !== 'client_gone') {
      // Shutdown / drain_timeout: the client may still be reading, or the
      // process is going away. Never admit.
      this.counters.refuse.not_client_gone++;
      return { refused: 'not_client_gone' };
    }
    if (!snapshot || snapshot.version !== 2 || !Array.isArray(snapshot.chunks)) {
      this.counters.refuse.bad_snapshot++;
      return { refused: 'bad_snapshot' };
    }
    if (!Number.isInteger(snapshot.consumedThrough) || snapshot.consumedThrough !== snapshot.stepOffset) {
      this.counters.refuse.bad_snapshot++;
      return { refused: 'bad_snapshot' };
    }
    if (!Number.isInteger(pin?.deadline) || pin.deadline <= this.now()) {
      this.counters.refuse.no_deadline++;
      return { refused: 'no_deadline' };
    }

    const now = this.now();
    this.sweepExpired(now);

    const existing = this.entries.get(key);
    if (existing?.state === 'claimed') {
      this.counters.refuse.busy++;
      return { refused: 'busy' };
    }
    if (existing) this.#delete(existing, 'superseded');

    if (this.#callerCount(callerKey) >= this.maxPerCaller) {
      // Per-caller cap: drop this caller's oldest running entry; never a
      // claimed one (a resumer owns it).
      if (!this.#evictOldestRunning('capacity', { callerKey })) {
        this.counters.refuse.over_entries++;
        return { refused: 'over_entries' };
      }
    }
    while (this.entries.size >= this.maxEntries) {
      if (!this.#evictOldestRunning('capacity')) {
        this.counters.refuse.over_entries++;
        return { refused: 'over_entries' };
      }
    }

    const bytes = snapshotBytes(snapshot, pin);
    if (bytes > this.maxEntryBytes || this.totalBytes + bytes > this.maxTotalBytes) {
      this.counters.refuse.over_bytes++;
      return { refused: 'over_bytes' };
    }

    const token = randomUUID();
    const entry = {
      key,
      callerKey,
      snapshot,
      pin: { ...pin },
      bytes,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      deadline: pin.deadline,
      state: 'running',
      token: null,
      timer: null,
    };
    this.entries.set(key, entry);
    this.totalBytes += bytes;
    this.#armTimer(entry, this.ttlMs);
    this.counters.admit++;
    return { token };
  }

  /** Read an entry. Does not change ownership; a claimed entry is still returned. */
  lookup(key, callerKey) {
    const entry = this.entries.get(key);
    if (!entry || entry.callerKey !== callerKey) {
      this.counters.lookup.miss++;
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.#delete(entry, 'ttl');
      this.counters.lookup.miss++;
      return null;
    }
    this.counters.lookup.hit++;
    return entry;
  }

  /**
   * CAS running → claimed. Synchronous by design: the expiry timer cannot
   * interleave between the state check and the assignment.
   */
  claim(key, callerKey) {
    const entry = this.entries.get(key);
    if (!entry || entry.callerKey !== callerKey) {
      this.counters.claim.gone++;
      return { refused: 'gone' };
    }
    if (entry.state !== 'running') {
      this.counters.claim.busy++;
      return { refused: 'busy' };
    }
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.#delete(entry, 'ttl');
      this.counters.claim.ttl++;
      return { refused: 'ttl' };
    }
    if (entry.deadline <= now) {
      this.#delete(entry, 'deadline');
      this.counters.claim.deadline++;
      return { refused: 'deadline' };
    }
    this.#clearTimer(entry);
    entry.state = 'claimed';
    entry.token = randomUUID();
    this.counters.claim.ok++;
    return { entry, token: entry.token };
  }

  /**
   * Finish a claim. `state: 'served'` deletes the entry (the resumer completed
   * through the normal success tail). `state: 'running'` re-detaches: the new
   * snapshot replaces the old one, the original TTL is NOT extended, and the
   * entry becomes claimable again.
   */
  release(key, token, { state = 'served', snapshot = null } = {}) {
    const entry = this.entries.get(key);
    if (!entry || entry.state !== 'claimed' || entry.token !== token) return false;

    if (state === 'served') {
      this.#delete(entry, null);
      this.counters.serve++;
      return true;
    }
    if (state !== 'running') return false;

    const now = this.now();
    if (entry.expiresAt <= now) {
      this.#delete(entry, 'ttl');
      return false;
    }
    if (!snapshot || snapshot.version !== 2
        || !Number.isInteger(snapshot.consumedThrough)
        || snapshot.consumedThrough !== snapshot.stepOffset) {
      this.#delete(entry, 'resume_miss');
      return false;
    }
    const bytes = snapshotBytes(snapshot, entry.pin);
    if (bytes > this.maxEntryBytes || this.totalBytes - entry.bytes + bytes > this.maxTotalBytes) {
      this.#delete(entry, 'capacity');
      return false;
    }
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes) + bytes;
    entry.snapshot = snapshot;
    entry.bytes = bytes;
    entry.state = 'running';
    entry.token = null;
    // Remaining TTL, not a fresh window: a re-detach must not buy extra time.
    this.#armTimer(entry, entry.expiresAt - now);
    this.counters.re_detach++;
    return true;
  }

  evict(key, cause = 'capacity') {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.#delete(entry, cause);
    return true;
  }

  evictForAccount(accountId) {
    if (!accountId) return 0;
    let evicted = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.pin?.accountId !== accountId) continue;
      this.#delete(entry, 'account_removed');
      evicted++;
    }
    return evicted;
  }

  /** Refuse admissions and drop every entry (shutdown / restart). */
  beginDrain() {
    this.draining = true;
    for (const entry of [...this.entries.values()]) this.#delete(entry, 'drain');
  }

  close() {
    this.beginDrain();
  }

  noteReplay(bytes) {
    if (Number.isFinite(bytes) && bytes > 0) this.counters.replay_bytes += bytes;
  }

  noteBilled() {
    this.counters.billed_detached++;
  }
}

// Process-wide instance used by the handler. Entries are in memory: a restart
// loses them, which is exactly today's abort outcome (the retry goes upstream).
export const detachedRegistry = new DetachedRegistry();

export function beginDetachDrain() {
  detachedRegistry.beginDrain();
}

export function evictForAccount(accountId) {
  return detachedRegistry.evictForAccount(accountId);
}

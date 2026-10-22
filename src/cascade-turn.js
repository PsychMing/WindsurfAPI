// Producer-level Cascade turn state (Q10 P1, research/Q10/REPORT.md §5.2).
//
// Why this exists: a Cascade trajectory is append-only while a turn is ACTIVE,
// and a step's responseText/thinking grows IN PLACE across polls. The answer
// does not stop at the last step index — E2b measured 596 → 16,632 chars
// inside the same three steps while the client was detached. A resume keyed on
// `stepOffset` alone therefore reads zero steps and returns an empty answer.
//
// The cursor is the design-critical state:
//   - `stepOffset` is the absolute index of the next unread step;
//   - `pollFloor` is the absolute offset this turn started from, so a resumed
//     cascade never replays pre-turn steps as fresh output;
//   - `yieldedByStep` / `thinkingByStep` are absolute-index → emitted-length
//     cursors, so re-reading the overlap window emits only real growth;
//   - the poll window starts at `max(pollFloor, stepOffset - overlap)`, never
//     at `stepOffset`, so growth inside an already-counted step is visible.
//
// `snapshot()` / `fromSnapshot()` are the lazy-resume contract. A snapshot
// without the per-step cursors is rejected: it cannot distinguish "already
// emitted" from "not yet read", which is exactly the E2b bug.

// Cascade steps are append-only while ACTIVE: a step's responseText/thinking
// grows in place across polls. Polling strictly after the last consumed step
// would strand that growth until the final sweep, so each poll re-reads this
// many already-seen steps. Bounded (not the whole trajectory) and floored at
// the turn's resume offset so pre-turn steps are never replayed.
export const CASCADE_STEP_OVERLAP = 8;

const SNAPSHOT_VERSION = 1;

// The feature flag is read at call time, not module load, so a test (or a
// future runtime config reload) can flip it without re-importing client.js.
// Default OFF: only the exact string '1' enables the producer path.
export function cascadeTurnEnabled(env = process.env) {
  return String(env.WINDSURFAPI_CASCADE_TURN || '') === '1';
}

/**
 * A snapshot that cannot be resumed safely. Named so callers can distinguish
 * a broken entry (drop it, retry upstream) from a transport failure.
 */
export class CascadeTurnCursorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CascadeTurnCursorError';
    this.code = 'CASCADE_TURN_CURSOR';
  }
}

function pairsFromMap(value, label) {
  if (value instanceof Map) {
    for (const [index, length] of value) {
      if (!Number.isInteger(index) || index < 0 || !Number.isInteger(length) || length < 0) {
        throw new CascadeTurnCursorError(`CascadeTurn ${label} has a non-integer cursor entry`);
      }
    }
    return new Map(value);
  }
  if (!Array.isArray(value)) {
    throw new CascadeTurnCursorError(`CascadeTurn ${label} must be a Map or an array of [index, length] pairs`);
  }
  const map = new Map();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new CascadeTurnCursorError(`CascadeTurn ${label} entry is not an [index, length] pair`);
    }
    const [index, length] = pair;
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(length) || length < 0) {
      throw new CascadeTurnCursorError(`CascadeTurn ${label} has a non-integer cursor entry`);
    }
    map.set(index, length);
  }
  return map;
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export class CascadeTurn {
  /**
   * @param {object} [options]
   * @param {string} [options.cascadeId]
   * @param {number} [options.stepOffset=0] absolute index of the next unread step
   * @param {number} [options.pollFloor=stepOffset] absolute offset this turn started from
   * @param {number} [options.overlap=CASCADE_STEP_OVERLAP] bounded re-read window
   * @param {Array} [options.chunks=[]] producer buffer (raw chunks, not SSE bytes)
   * @param {(chunk: object) => any} [options.emit] sink called after each chunk is buffered
   * @param {Map|Array} [options.yieldedByStep]
   * @param {Map|Array} [options.thinkingByStep]
   * @param {number} [options.totalYielded=0]
   * @param {number} [options.totalThinking=0]
   * @param {boolean} [options.sawText=false]
   */
  constructor({
    cascadeId = '',
    stepOffset = 0,
    pollFloor = stepOffset,
    overlap = CASCADE_STEP_OVERLAP,
    chunks = [],
    emit = null,
    yieldedByStep = new Map(),
    thinkingByStep = new Map(),
    totalYielded = 0,
    totalThinking = 0,
    sawText = false,
  } = {}) {
    if (!Number.isInteger(stepOffset) || stepOffset < 0) {
      throw new CascadeTurnCursorError(`CascadeTurn stepOffset must be a non-negative integer, got ${stepOffset}`);
    }
    if (!Number.isInteger(pollFloor) || pollFloor < 0 || pollFloor > stepOffset) {
      throw new CascadeTurnCursorError(`CascadeTurn pollFloor must be an integer in [0, stepOffset], got ${pollFloor}`);
    }
    this.cascadeId = cascadeId;
    this.stepOffset = stepOffset;
    this.pollFloor = pollFloor;
    this.overlap = positiveInt(overlap, CASCADE_STEP_OVERLAP);
    this.chunks = chunks;
    this.emit = typeof emit === 'function' ? emit : null;
    this.yieldedByStep = pairsFromMap(yieldedByStep, 'yieldedByStep');
    this.thinkingByStep = pairsFromMap(thinkingByStep, 'thinkingByStep');
    this.totalYielded = Number.isFinite(totalYielded) ? totalYielded : 0;
    this.totalThinking = Number.isFinite(totalThinking) ? totalThinking : 0;
    this.sawText = !!sawText;
    this.lastWindowStart = pollFloor;
    this.lastGrowthAt = Date.now();
    // Set by fromSnapshot: the exact window the detached turn would have read
    // next. Used once, then the live formula takes over.
    this.resumeWindowStart = null;
  }

  /** Window start the next poll would use. Does not consume a pending resume. */
  nextWindowStart() {
    if (this.resumeWindowStart !== null) return this.resumeWindowStart;
    return Math.max(this.pollFloor, this.stepOffset - this.overlap);
  }

  /** The produced text so far (all chunks, including pre-detach). */
  get text() {
    let out = '';
    for (const chunk of this.chunks) out += chunk?.text || '';
    return out;
  }

  /** The produced thinking so far. */
  get thinking() {
    let out = '';
    for (const chunk of this.chunks) out += chunk?.thinking || '';
    return out;
  }

  /**
   * One GetCascadeTrajectorySteps read. Advances `stepOffset` and records the
   * window; does NOT consume the steps (call consumeStep in the caller's order
   * so tool-call chunks interleave exactly as they do in the foreground loop).
   *
   * @param {(windowStart: number) => Promise<Array>} fetchSteps
   */
  async readWindow(fetchSteps) {
    if (typeof fetchSteps !== 'function') {
      throw new TypeError('CascadeTurn.readWindow requires a fetchSteps(windowStart) function');
    }
    const windowStart = this.nextWindowStart();
    const steps = await fetchSteps(windowStart);
    if (!Array.isArray(steps)) {
      throw new TypeError('CascadeTurn fetchSteps must resolve to an array of steps');
    }
    // Only consume the pending resume window after a successful read: a
    // transient fetch failure must retry the same (older, wider) window.
    this.resumeWindowStart = null;
    this.lastWindowStart = windowStart;
    const previousStepOffset = this.stepOffset;
    const nextStepOffset = windowStart + steps.length;
    if (nextStepOffset > this.stepOffset) this.stepOffset = nextStepOffset;
    const advanced = this.stepOffset > previousStepOffset;
    if (advanced) this.lastGrowthAt = Date.now();
    return {
      windowStart,
      steps,
      advanced,
      stepOffset: this.stepOffset,
    };
  }

  /**
   * Emit the thinking/text growth of one step since its cursor. The cursor is
   * advanced before the sink await, matching the foreground loop: a slow or
   * failed consumer must not cause the same delta to be emitted twice.
   *
   * @returns {Promise<{textDelta: string, thinkingDelta: string, grew: boolean}>}
   */
  async consumeStep(step, stepIndex) {
    let thinkingDelta = '';
    const liveThink = step?.thinking || '';
    if (liveThink) {
      const prevThink = this.thinkingByStep.get(stepIndex) || 0;
      if (liveThink.length > prevThink) {
        thinkingDelta = liveThink.slice(prevThink);
        this.thinkingByStep.set(stepIndex, liveThink.length);
        this.totalThinking += thinkingDelta.length;
        this.lastGrowthAt = Date.now();
        await this.#emit({ text: '', thinking: thinkingDelta, isError: false });
      }
    }

    let textDelta = '';
    const liveText = step?.responseText || step?.text || '';
    if (liveText) {
      const prev = this.yieldedByStep.get(stepIndex) || 0;
      if (liveText.length > prev) {
        textDelta = liveText.slice(prev);
        this.yieldedByStep.set(stepIndex, liveText.length);
        this.totalYielded += textDelta.length;
        this.sawText = true;
        this.lastGrowthAt = Date.now();
        await this.#emit({ text: textDelta, thinking: '', isError: false });
      }
    }

    return { textDelta, thinkingDelta, grew: !!(textDelta || thinkingDelta) };
  }

  /**
   * The final IDLE sweep's polish pass. `responseText` is topped up first;
   * `modifiedText` is only appended when it is a strict extension of
   * responseText (a rewrite would splice wrong bytes onto the stream).
   */
  async consumeFinalStep(step, stepIndex) {
    const responseText = step?.responseText || '';
    const modifiedText = step?.modifiedText || '';
    let textDelta = '';

    const prev = this.yieldedByStep.get(stepIndex) || 0;
    if (responseText.length > prev) {
      textDelta = responseText.slice(prev);
      this.yieldedByStep.set(stepIndex, responseText.length);
      this.totalYielded += textDelta.length;
      this.lastGrowthAt = Date.now();
      await this.#emit({ text: textDelta, thinking: '', isError: false });
    }

    const cursor = this.yieldedByStep.get(stepIndex) || 0;
    if (modifiedText.length > cursor && modifiedText.startsWith(responseText)) {
      const polish = modifiedText.slice(cursor);
      this.yieldedByStep.set(stepIndex, modifiedText.length);
      this.totalYielded += polish.length;
      this.lastGrowthAt = Date.now();
      await this.#emit({ text: polish, thinking: '', isError: false });
      textDelta += polish;
    }

    return { textDelta };
  }

  /**
   * Fetch + consume in one call. This is the pump's entry point; the
   * foreground loop uses readWindow/consumeStep separately so its per-step
   * tool-call handling keeps its exact ordering.
   *
   * `beforeStep` runs before the step's deltas are consumed and may return
   * false to stop (e.g. the native-tool proposal hand-off). `afterStep` runs
   * after the deltas.
   */
  async pollOnce(fetchSteps, { beforeStep, afterStep } = {}) {
    const read = await this.readWindow(fetchSteps);
    let grew = read.advanced;
    let stopped = false;
    for (let i = 0; i < read.steps.length; i++) {
      const step = read.steps[i];
      const stepIndex = read.windowStart + i;
      if (typeof beforeStep === 'function' && (await beforeStep(step, stepIndex)) === false) {
        stopped = true;
        break;
      }
      const consumed = await this.consumeStep(step, stepIndex);
      grew = grew || consumed.grew;
      await afterStep?.(step, stepIndex, consumed);
    }
    return { ...read, grew, stopped };
  }

  /** Move the next-unread cursor forward (the final sweep can see new steps). */
  advanceTo(stepOffset) {
    if (Number.isInteger(stepOffset) && stepOffset > this.stepOffset) {
      this.stepOffset = stepOffset;
    }
    return this.stepOffset;
  }

  /**
   * The resumable producer state. The cursor maps are JSON-safe [index,
   * length] arrays; chunks are shallow copies (nested tool payloads keep
   * their original object identity).
   */
  snapshot() {
    return {
      version: SNAPSHOT_VERSION,
      cascadeId: this.cascadeId,
      stepOffset: this.stepOffset,
      pollFloor: this.pollFloor,
      windowStart: this.nextWindowStart(),
      lastWindowStart: this.lastWindowStart,
      overlap: this.overlap,
      yieldedByStep: [...this.yieldedByStep.entries()].sort((a, b) => a[0] - b[0]),
      thinkingByStep: [...this.thinkingByStep.entries()].sort((a, b) => a[0] - b[0]),
      totalYielded: this.totalYielded,
      totalThinking: this.totalThinking,
      sawText: this.sawText,
      chunks: this.chunks.map(chunk => ({ ...chunk })),
    };
  }

  /**
   * Restore a detached turn. Refuses a snapshot without per-step cursors:
   * `stepOffset` alone cannot tell which bytes were already emitted, and
   * starting the window there is the E2b "0 steps / 0 chars" bug.
   *
   * @param {object} snapshot
   * @param {object} [options]
   * @param {(chunk: object) => any} [options.emit]
   */
  static fromSnapshot(snapshot, { emit = null } = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new CascadeTurnCursorError('CascadeTurn.fromSnapshot requires a snapshot object');
    }
    if (snapshot.version != null && snapshot.version !== SNAPSHOT_VERSION) {
      throw new CascadeTurnCursorError(`CascadeTurn snapshot version ${snapshot.version} is not supported (expected ${SNAPSHOT_VERSION})`);
    }
    if (!Number.isInteger(snapshot.stepOffset) || snapshot.stepOffset < 0) {
      throw new CascadeTurnCursorError('CascadeTurn snapshot has no valid stepOffset');
    }
    if (!Number.isInteger(snapshot.pollFloor) || snapshot.pollFloor < 0 || snapshot.pollFloor > snapshot.stepOffset) {
      throw new CascadeTurnCursorError('CascadeTurn snapshot has no valid pollFloor');
    }
    if (!Array.isArray(snapshot.yieldedByStep) || !Array.isArray(snapshot.thinkingByStep)) {
      throw new CascadeTurnCursorError(
        'CascadeTurn snapshot has no per-step cursors (yieldedByStep/thinkingByStep); '
        + 'resuming from stepOffset alone returns zero steps (Q10 E2b: stepOffset=3 → 0 steps / 0 chars)',
      );
    }

    const turn = new CascadeTurn({
      cascadeId: snapshot.cascadeId,
      stepOffset: snapshot.stepOffset,
      pollFloor: snapshot.pollFloor,
      overlap: snapshot.overlap,
      chunks: Array.isArray(snapshot.chunks)
        ? snapshot.chunks.map(chunk => (chunk && typeof chunk === 'object' ? { ...chunk } : chunk))
        : [],
      emit,
      yieldedByStep: snapshot.yieldedByStep,
      thinkingByStep: snapshot.thinkingByStep,
      totalYielded: snapshot.totalYielded,
      totalThinking: snapshot.totalThinking,
      sawText: snapshot.sawText,
    });

    if (Number.isInteger(snapshot.windowStart)) {
      if (snapshot.windowStart < snapshot.pollFloor || snapshot.windowStart > snapshot.stepOffset) {
        throw new CascadeTurnCursorError(
          `CascadeTurn snapshot windowStart ${snapshot.windowStart} is outside [${snapshot.pollFloor}, ${snapshot.stepOffset}]`,
        );
      }
      turn.resumeWindowStart = snapshot.windowStart;
    }
    if (Number.isInteger(snapshot.lastWindowStart)) turn.lastWindowStart = snapshot.lastWindowStart;
    return turn;
  }

  async #emit(chunk) {
    this.chunks.push(chunk);
    if (this.emit) await this.emit(chunk);
  }
}

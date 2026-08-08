// animation-playback-store.ts - Zustand store for playback state machine (migrated from usePlayerEngine/playerReducer)

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { devtools, persist, subscribeWithSelector } from 'zustand/middleware';
import type { AnimationStep, PlayerPhase, PlayMode, PlayEdition, ReplayableItem, SpreadHistoryEntry } from '@/types/playable-types';
import type { Section } from '@/types/illustration-types';
import {
  findNextOnNextStep,
  findOnClickStepForTarget,
} from '@/features/editor/components/playable-spread-view/player-utils';
import { createLogger } from '@/utils/logger';
import { createSafePersistStorage } from './safe-persist-storage';

const log = createLogger('Store', 'AnimationPlaybackStore');

// === Lifecycle ===

/**
 * Playback store lifecycle states.
 *
 * - `idle`: store mounted but no session context yet. All session-bound actions noop (log debug).
 * - `initializing`: transient, between `initialize()` start and atomic commit.
 * - `ready`: session context applied; actions live.
 * - `error`: watchdog fired — `initialize()` didn't arrive within `INIT_TIMEOUT_MS`. Actions noop (log warn).
 *
 * Transitions:
 *   idle ──initialize()──► initializing ──► ready
 *   idle ──watchdog 5s──► error
 *   ready ──teardown()──► idle
 *   ready ──initialize(newPayload)──► initializing ──► ready  (source switch)
 *   error ──initialize(payload)──► initializing ──► ready  (retry)
 *
 * See ADR-030 (playback-store-lifecycle).
 */
export type PlaybackLifecycle = 'idle' | 'initializing' | 'ready' | 'error';

export interface AvailableEditions {
  classic?: boolean;
  dynamic?: boolean;
  interactive?: boolean;
}

/** Payload for atomic `initialize` action — gathered by container, committed in one set(). */
export interface InitializePayload {
  /** Unique session identifier: `'original:<bookId>' | 'remix:<id>' | 'demo:<seed>' | 'share:<token>'`. */
  sessionId: string;
  /** Active language code (e.g. `'en_US'`). */
  language: string;
  /** Default edition for this session. Only applied if (a) lifecycle was `idle`, or (b) sessionId differs. */
  edition: PlayEdition;
  /** Optional edition availability constraint (share-preview narrows; editor leaves undefined = full). */
  availableEditions?: AvailableEditions;
  /** Seed spreadId for navigation history (first entry pushed via clearSpreadHistory + push). */
  startSpreadId: string;
}

const INIT_TIMEOUT_MS = 5000;

// === State & Actions interfaces ===

interface PlaybackState {
  lifecycle: PlaybackLifecycle;
  sessionId: string | null;
  playMode: PlayMode;
  playEdition: PlayEdition;
  isPlaying: boolean;
  volume: number;        // 0..100
  isMuted: boolean;
  phase: PlayerPhase;
  steps: AnimationStep[];
  currentStepIndex: number;  // -1 = not started
  pendingClickTargetId: string | null;
  replayableItems: Map<string, ReplayableItem>;
  /** Live remaining-play counter per animation order (eLoop sidebar display).
   *  Seeded only for finite loops > 1; absent entry = render static effect.loop. */
  effectLoopRemaining: Map<number, number>;
  activeAnimationOrders: number[];
  maxActivatedOrder: number; // highest order ever passed to addActiveAnimationOrder (reset per phase)
  narrationLanguage: string; // language code for narration audio (e.g. 'en_US')
  quizLanguage: string;      // language code for quiz content (e.g. 'en_US')
  spreadHistories: SpreadHistoryEntry[]; // breadcrumb trail for branching navigation
  currentSection: Section | null;        // active section in current player context
  /** Spread-turn transition gate — when `true`, autoplay-driven effects in
   *  `usePlayerGsapEngine` must NOT kick off (spec §7). Cleared by
   *  `resumeAutoplay()` after the turn finishes. Transient — reset by `initialize`/`teardown`. */
  autoplaySuspended: boolean;
}

interface PlaybackActions {
  /** Atomic session init — sets lifecycle to ready, seeds history, conditionally applies edition. */
  initialize: (payload: InitializePayload) => void;
  /** Return to idle, preserve user prefs (volume, mute, languages, edition, playMode). Idempotent. */
  teardown: () => void;
  play: () => void;
  pause: () => void;
  setPlayMode: (mode: PlayMode) => void;
  setPlayEdition: (edition: PlayEdition) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  reset: (steps: AnimationStep[]) => void;
  userNext: () => void;
  userBack: () => void;
  userClick: (itemId: string) => void;
  stepComplete: () => void;
  cancelAndNext: () => void;
  clickLoopReplay: (itemId: string) => { shouldReplay: boolean; step?: AnimationStep };
  setNarrationLanguage: (code: string) => void;
  setQuizLanguage: (code: string) => void;
  pushSpreadHistory: (spreadId: string, section: Section | null) => void;
  popSpreadHistory: () => SpreadHistoryEntry | null;
  clearSpreadHistory: () => void;
  setCurrentSection: (section: Section | null) => void;
  setActiveAnimationOrders: (orders: number[]) => void;
  addActiveAnimationOrder: (order: number) => void;
  removeActiveAnimationOrder: (order: number) => void;
  setEffectLoopRemaining: (order: number, count: number) => void;
  decrementEffectLoopRemaining: (order: number) => void;
  /** Clear single entry when `order` provided, or wipe map otherwise. */
  clearEffectLoopRemaining: (order?: number) => void;
  /** Set `autoplaySuspended = true` — gates autoplay-driven effects during a turn.
   *  Idempotent; logs at `debug` if already suspended. */
  suspendAutoplay: () => void;
  /** Set `autoplaySuspended = false` — releases the gate.
   *  Idempotent; logs at `debug` if already resumed. */
  resumeAutoplay: () => void;
}

// === Initial state ===

const INITIAL_STATE: PlaybackState = {
  lifecycle: 'idle',
  sessionId: null,
  playMode: 'off',
  // Default = highest edition. Restricted contexts (e.g. share-preview with
  // classic-only books) correct down via `initialize` payload on first session.
  playEdition: 'interactive',
  isPlaying: false,     // wait for `initialize` to seed session, then consumer triggers play
  volume: 100,
  isMuted: false,
  phase: 'idle',
  steps: [],
  currentStepIndex: -1,
  pendingClickTargetId: null,
  replayableItems: new Map(),
  effectLoopRemaining: new Map(),
  activeAnimationOrders: [],
  maxActivatedOrder: -1,
  narrationLanguage: 'en_US',
  quizLanguage: 'en_US',
  spreadHistories: [],
  currentSection: null,
  autoplaySuspended: false,
};

// === Store creation ===

export const usePlaybackStore = create<PlaybackState & PlaybackActions>()(
  devtools(
    subscribeWithSelector(
      persist((set, get) => {
        // ── Watchdog timer (module-scoped to factory closure) ────────────────
        // When a guarded action is called in `idle` state, start a 5s timer.
        // If `initialize` doesn't arrive before expiry, transition `idle → error`
        // so the UI can surface an affordance instead of silently hanging.
        let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

        const startWatchdog = () => {
          if (watchdogTimer !== null) return;
          const timerId: ReturnType<typeof setTimeout> = setTimeout(() => {
            // Supersession guard: if `watchdogTimer` was reassigned/cleared while
            // we slept, drop this fire. Defends against React Strict Mode double-
            // invoke and hot-reload paths where a stale closure could still fire.
            if (watchdogTimer !== timerId) return;
            watchdogTimer = null;
            if (get().lifecycle === 'idle') {
              log.warn('watchdog', 'initialize timeout — transitioning to error', { timeoutMs: INIT_TIMEOUT_MS });
              set({ lifecycle: 'error' });
            }
          }, INIT_TIMEOUT_MS);
          watchdogTimer = timerId;
        };

        const clearWatchdog = () => {
          if (watchdogTimer !== null) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }
        };

        // ── Guard helper ─────────────────────────────────────────────────────
        // Returns `true` if the action may run (lifecycle === 'ready'),
        // otherwise logs a noop reason and returns `false`. Distinguishes
        // `error` (warn — indicates upstream failure) from `idle`/`initializing`
        // (debug — normal pre-init or transient).
        const requireReady = (actionName: string): boolean => {
          const lifecycle = get().lifecycle;
          if (lifecycle === 'ready') return true;
          if (lifecycle === 'idle') {
            startWatchdog();
            log.debug(actionName, 'noop — lifecycle idle', { lifecycle });
          } else if (lifecycle === 'error') {
            log.warn(actionName, 'noop — lifecycle in error state', { lifecycle });
          } else {
            log.debug(actionName, 'noop — lifecycle initializing', { lifecycle });
          }
          return false;
        };

        return {
          ...INITIAL_STATE,

          // ── Lifecycle ─────────────────────────────────────────────────────

          initialize: (payload) => {
            const prevLifecycle = get().lifecycle;
            const prevSessionId = get().sessionId;

            // Idempotent: same session already ready → noop. Defense against
            // double-dispatch (Strict Mode dev re-mount, or consumer re-firing
            // with an unchanged payload). Without this, isPlaying/phase/steps
            // would be clobbered mid-playback.
            if (prevLifecycle === 'ready' && prevSessionId === payload.sessionId) {
              log.debug('initialize', 'idempotent skip — same session ready', {
                sessionId: payload.sessionId,
              });
              return;
            }

            log.info('initialize', 'start', {
              sessionId: payload.sessionId,
              prevLifecycle,
              prevSessionId,
            });

            clearWatchdog();

            // Edition apply policy: first init from idle/error, or session switch.
            // Same-session re-init preserves the in-memory user toggle.
            const shouldApplyEdition =
              prevLifecycle === 'idle' ||
              prevLifecycle === 'error' ||
              prevSessionId !== payload.sessionId;

            // Single atomic commit — skip the transient `initializing` state
            // (no consumer needs to distinguish it from `idle`; rendering an
            // intermediate state caused a one-frame skeleton flash on source
            // switch). Keep `initializing` in the type for future async-init.
            set({
              lifecycle: 'ready',
              sessionId: payload.sessionId,
              spreadHistories: [{ spreadId: payload.startSpreadId, section: null }],
              currentSection: null,
              pendingClickTargetId: null,
              autoplaySuspended: false,
              isPlaying: false,
              phase: 'idle',
              steps: [],
              currentStepIndex: -1,
              replayableItems: new Map(),
              effectLoopRemaining: new Map(),
              activeAnimationOrders: [],
              maxActivatedOrder: -1,
              narrationLanguage: payload.language,
              ...(shouldApplyEdition ? { playEdition: payload.edition } : {}),
            });

            log.info('initialize', 'ready', {
              sessionId: payload.sessionId,
              applyEdition: shouldApplyEdition,
            });
          },

          teardown: () => {
            // Always clear the watchdog first — a stale timer from a previous
            // session can leak across tests / hot-reloads otherwise.
            clearWatchdog();
            if (get().lifecycle === 'idle') {
              log.debug('teardown', 'already idle — noop');
              return;
            }
            log.info('teardown', 'returning to idle');
            set({
              lifecycle: 'idle',
              sessionId: null,
              spreadHistories: [],
              currentSection: null,
              pendingClickTargetId: null,
              autoplaySuspended: false,
              isPlaying: false,
              phase: 'idle',
              steps: [],
              currentStepIndex: -1,
              replayableItems: new Map(),
              effectLoopRemaining: new Map(),
              activeAnimationOrders: [],
              maxActivatedOrder: -1,
              // preserve: volume, isMuted, narrationLanguage, quizLanguage, playEdition, playMode
            });
          },

          // ── Playback Controls ────────────────────────────────────────────

          play: () => {
            if (!requireReady('play')) return;
            log.info('play', 'playing');
            set({ isPlaying: true });
          },

          pause: () => {
            if (!requireReady('pause')) return;
            log.info('pause', 'paused');
            set({ isPlaying: false });
          },

          // User-pref / mode actions — NOT guarded (allow toggle pre-init).

          setPlayMode: (mode) => {
            const prev = get().playMode;
            log.info('setPlayMode', 'transition', { prev, next: mode });
            set({ playMode: mode });
          },

          setPlayEdition: (version) => {
            const prev = get().playEdition;
            log.info('setPlayEdition', 'transition', { prev, next: version });
            set({ playEdition: version });
          },

          setNarrationLanguage: (code) => {
            const prev = get().narrationLanguage;
            log.info('setNarrationLanguage', 'transition', { prev, next: code });
            set({ narrationLanguage: code });
          },

          setQuizLanguage: (code) => {
            const prev = get().quizLanguage;
            log.info('setQuizLanguage', 'transition', { prev, next: code });
            set({ quizLanguage: code });
          },

          pushSpreadHistory: (spreadId, section) => {
            if (!requireReady('pushSpreadHistory')) return;
            const current = get().spreadHistories;
            log.debug('pushSpreadHistory', 'push', {
              spreadId,
              sectionId: section?.id ?? null,
              newLength: current.length + 1,
            });
            set({ spreadHistories: [...current, { spreadId, section }] });
          },

          popSpreadHistory: () => {
            if (!requireReady('popSpreadHistory')) return null;
            const { spreadHistories } = get();
            if (spreadHistories.length <= 1) {
              log.debug('popSpreadHistory', 'at root, nothing to pop');
              return null;
            }
            const newHistories = spreadHistories.slice(0, -1);
            const newTop = newHistories[newHistories.length - 1];
            log.debug('popSpreadHistory', 'pop', {
              newLength: newHistories.length,
              newTopId: newTop.spreadId,
            });
            set({ spreadHistories: newHistories, currentSection: newTop.section });
            return newTop;
          },

          clearSpreadHistory: () => {
            if (!requireReady('clearSpreadHistory')) return;
            log.debug('clearSpreadHistory', 'clear');
            set({ spreadHistories: [], currentSection: null });
          },

          setCurrentSection: (section) => {
            if (!requireReady('setCurrentSection')) return;
            log.debug('setCurrentSection', 'set', { sectionId: section?.id ?? null });
            set({ currentSection: section });
          },

          setVolume: (v) => {
            const clamped = Math.min(100, Math.max(0, v));
            set({ volume: clamped, ...(clamped > 0 ? { isMuted: false } : {}) });
          },

          toggleMute: () => {
            const { isMuted, volume } = get();
            log.info('toggleMute', 'transition', { prev: isMuted, volume });
            if (isMuted) {
              // Unmuting — if volume was 0, restore to 100
              set({ isMuted: false, ...(volume === 0 ? { volume: 100 } : {}) });
            } else {
              set({ isMuted: true });
            }
          },

          // ── RESET — mirrors playerReducer case 'RESET' ───────────────────

          reset: (steps) => {
            if (!requireReady('reset')) return;
            log.info('reset', 'start', { stepCount: steps.length, firstTrigger: steps[0]?.triggerType });
            const replayableItems = new Map<string, ReplayableItem>();

            if (steps.length === 0) {
              set({
                phase: 'idle',
                steps: [],
                currentStepIndex: -1,
                pendingClickTargetId: null,
                replayableItems,
                effectLoopRemaining: new Map(),
                activeAnimationOrders: [],
                maxActivatedOrder: -1,
              });
              return;
            }

            // Auto step[0] → start playing immediately
            if (steps[0].triggerType === 'auto') {
              log.debug('reset', 'phase → playing (auto trigger)', { stepCount: steps.length });
              set({
                phase: 'playing',
                steps,
                currentStepIndex: 0,
                pendingClickTargetId: null,
                replayableItems,
                effectLoopRemaining: new Map(),
                activeAnimationOrders: [],
                maxActivatedOrder: -1,
              });
              return;
            }

            // On-click step[0] → wait for user to click the target item
            if (steps[0].triggerType === 'on_click') {
              log.debug('reset', 'phase → awaiting_click', { targetId: steps[0].targetId });
              set({
                phase: 'awaiting_click',
                steps,
                currentStepIndex: -1,
                pendingClickTargetId: steps[0].targetId ?? null,
                replayableItems,
                effectLoopRemaining: new Map(),
                activeAnimationOrders: [],
                maxActivatedOrder: -1,
              });
              return;
            }

            // on_next → idle, wait for user to press Next
            log.debug('reset', 'phase → idle (on_next trigger)');
            set({
              phase: 'idle',
              steps,
              currentStepIndex: -1,
              pendingClickTargetId: null,
              replayableItems,
              effectLoopRemaining: new Map(),
              activeAnimationOrders: [],
              maxActivatedOrder: -1,
            });
          },

          // ── USER_NEXT — mirrors playerReducer case 'USER_NEXT' ──────────

          userNext: () => {
            if (!requireReady('userNext')) return;
            const { phase, steps, currentStepIndex } = get();
            log.info('userNext', 'action', { phase, currentStepIndex });
            if (phase === 'playing' || phase === 'complete') return;

            // From idle, awaiting_next, or awaiting_click → find next on_next step
            const nextIdx = findNextOnNextStep(steps, currentStepIndex + 1);
            if (nextIdx >= 0) {
              set({ phase: 'playing', currentStepIndex: nextIdx, pendingClickTargetId: null, maxActivatedOrder: -1 });
              return;
            }

            // No on_next step found — if currently awaiting_click, stay
            if (phase === 'awaiting_click') return;
            set({ phase: 'complete', pendingClickTargetId: null });
          },

          // ── USER_BACK — revert current step, don't auto-play ────────────
          // Decrements currentStepIndex so the next userNext() replays the reverted step.
          // Visual revert is handled by the component (reApplyInitialStates) before calling this.

          userBack: () => {
            if (!requireReady('userBack')) return;
            const { currentStepIndex, steps } = get();
            log.info('userBack', 'action', { currentStepIndex });
            if (currentStepIndex < 0) return;

            const newIdx = currentStepIndex - 1;
            // The step that will replay is newIdx + 1 (the one we just reverted).
            // If that step is 'auto' (after_previous/with_previous), it must auto-play
            // because it can't be triggered by user input.
            const replayStep = steps[newIdx + 1];
            const shouldAutoPlay = replayStep?.triggerType === 'auto';

            set({
              phase: shouldAutoPlay ? 'playing' : 'awaiting_next',
              currentStepIndex: newIdx,
              pendingClickTargetId: null,
              maxActivatedOrder: -1,
            });
          },

          // ── USER_CLICK — mirrors playerReducer case 'USER_CLICK' ────────

          userClick: (itemId) => {
            if (!requireReady('userClick')) return;
            const { phase, steps, currentStepIndex } = get();
            log.info('userClick', 'action', { itemId, phase });
            if (phase !== 'awaiting_click') return;

            const clickIdx = findOnClickStepForTarget(steps, currentStepIndex, itemId);
            if (clickIdx >= 0) {
              set({ phase: 'playing', currentStepIndex: clickIdx, pendingClickTargetId: null, maxActivatedOrder: -1 });
            }
            // Wrong target — ignore
          },

          // ── STEP_COMPLETE — mirrors playerReducer case 'STEP_COMPLETE' ──

          stepComplete: () => {
            if (!requireReady('stepComplete')) return;
            const { phase, steps, currentStepIndex, replayableItems } = get();
            log.info('stepComplete', 'action', { phase, currentStepIndex });
            if (phase !== 'playing') return;

            const completedStep = steps[currentStepIndex];
            const newReplayableItems = new Map(replayableItems);

            // Register click_loop if applicable
            if (
              completedStep?.triggerType === 'on_click' &&
              completedStep.targetId &&
              (completedStep.clickLoop ?? 0) > 0
            ) {
              newReplayableItems.set(completedStep.targetId, {
                itemId: completedStep.targetId,
                stepIndex: currentStepIndex,
                remainingReplays: completedStep.clickLoop!,
              });
            }

            // Determine next step
            const nextIdx = currentStepIndex + 1;
            if (nextIdx >= steps.length) {
              log.debug('stepComplete', 'phase → complete');
              set({
                phase: 'complete',
                replayableItems: newReplayableItems,
              });
              return;
            }

            const nextStep = steps[nextIdx];
            if (nextStep.triggerType === 'auto') {
              set({
                phase: 'playing',
                currentStepIndex: nextIdx,
                replayableItems: newReplayableItems,
                maxActivatedOrder: -1,
              });
              return;
            }
            if (nextStep.triggerType === 'on_click') {
              log.debug('stepComplete', 'phase → awaiting_click', { targetId: nextStep.targetId });
              set({
                phase: 'awaiting_click',
                pendingClickTargetId: nextStep.targetId ?? null,
                replayableItems: newReplayableItems,
              });
              return;
            }
            // on_next
            log.debug('stepComplete', 'phase → awaiting_next');
            set({
              phase: 'awaiting_next',
              pendingClickTargetId: null,
              replayableItems: newReplayableItems,
            });
          },

          // ── CANCEL_AND_NEXT — advance without registering click_loop ────

          cancelAndNext: () => {
            if (!requireReady('cancelAndNext')) return;
            const { phase, steps, currentStepIndex } = get();
            log.info('cancelAndNext', 'action', { phase, currentStepIndex });
            if (phase !== 'playing') return;

            // Do NOT register click_loop replayable items — just advance
            const nextIdx = currentStepIndex + 1;
            if (nextIdx >= steps.length) {
              set({ phase: 'complete' });
              return;
            }

            const nextStep = steps[nextIdx];
            if (nextStep.triggerType === 'auto') {
              set({ phase: 'playing', currentStepIndex: nextIdx, maxActivatedOrder: -1 });
              return;
            }
            if (nextStep.triggerType === 'on_click') {
              set({ phase: 'awaiting_click', pendingClickTargetId: nextStep.targetId ?? null });
              return;
            }
            // on_next
            set({ phase: 'awaiting_next', pendingClickTargetId: null });
          },

          // ── CLICK_LOOP_REPLAY — modified from playerReducer case 'CLICK_LOOP_REPLAY' ──
          // Returns { shouldReplay, step? } instead of updating state only

          clickLoopReplay: (itemId) => {
            if (!requireReady('clickLoopReplay')) return { shouldReplay: false };
            const { phase, replayableItems, steps } = get();
            log.info('clickLoopReplay', 'action', { itemId, phase });

            // Ignore during active playback
            if (phase === 'playing') return { shouldReplay: false };

            const replayable = replayableItems.get(itemId);
            if (!replayable || replayable.remainingReplays <= 0) {
              log.debug('clickLoopReplay', 'no replays remaining', { itemId });
              return { shouldReplay: false };
            }

            // Decrement remaining count and update state
            const newReplayableItems = new Map(replayableItems);
            newReplayableItems.set(itemId, {
              ...replayable,
              remainingReplays: replayable.remainingReplays - 1,
            });
            set({ replayableItems: newReplayableItems });

            return { shouldReplay: true, step: steps[replayable.stepIndex] };
          },

          // ── ACTIVE / PENDING ANIMATION ORDERS — for sidebar highlight ───

          setActiveAnimationOrders: (orders) => {
            if (!requireReady('setActiveAnimationOrders')) return;
            set({
              activeAnimationOrders: orders,
              ...(orders.length === 0 ? {} : { maxActivatedOrder: Math.max(...orders) }),
            });
          },

          addActiveAnimationOrder: (order) => {
            if (!requireReady('addActiveAnimationOrder')) return;
            const current = get().activeAnimationOrders;
            if (current.includes(order)) return;
            set({
              activeAnimationOrders: [...current, order],
              maxActivatedOrder: Math.max(get().maxActivatedOrder, order),
            });
          },

          removeActiveAnimationOrder: (order) => {
            if (!requireReady('removeActiveAnimationOrder')) return;
            const current = get().activeAnimationOrders;
            const filtered = current.filter((o) => o !== order);
            if (filtered.length !== current.length) {
              set({ activeAnimationOrders: filtered });
            }
          },

          setEffectLoopRemaining: (order, count) => {
            if (!requireReady('setEffectLoopRemaining')) return;
            const next = new Map(get().effectLoopRemaining);
            next.set(order, count);
            set({ effectLoopRemaining: next });
          },

          decrementEffectLoopRemaining: (order) => {
            if (!requireReady('decrementEffectLoopRemaining')) return;
            const current = get().effectLoopRemaining;
            const v = current.get(order);
            if (v === undefined) return;
            const next = new Map(current);
            next.set(order, Math.max(0, v - 1));
            set({ effectLoopRemaining: next });
          },

          clearEffectLoopRemaining: (order) => {
            if (!requireReady('clearEffectLoopRemaining')) return;
            if (order === undefined) {
              if (get().effectLoopRemaining.size === 0) return;
              set({ effectLoopRemaining: new Map() });
              return;
            }
            const current = get().effectLoopRemaining;
            if (!current.has(order)) return;
            const next = new Map(current);
            next.delete(order);
            set({ effectLoopRemaining: next });
          },

          // ── AUTOPLAY SUSPEND / RESUME — used by spread-turn transition (spec §7) ──

          suspendAutoplay: () => {
            if (!requireReady('suspendAutoplay')) return;
            const prev = get().autoplaySuspended;
            if (prev) {
              log.debug('suspendAutoplay', 'already suspended — noop');
              return;
            }
            log.info('suspendAutoplay', 'suspending', { previous: prev });
            set({ autoplaySuspended: true });
          },

          resumeAutoplay: () => {
            if (!requireReady('resumeAutoplay')) return;
            const prev = get().autoplaySuspended;
            if (!prev) {
              log.debug('resumeAutoplay', 'already resumed — noop');
              return;
            }
            log.info('resumeAutoplay', 'resuming', { previous: prev });
            set({ autoplaySuspended: false });
          },
        };
      }, {
        name: 'playback-preferences',
        // Safe storage: falls back to in-memory when localStorage is blocked
        // (Safari ITP in the embedded Player iframe). Same JSON shape/keys.
        storage: createSafePersistStorage(),
        partialize: (state) => ({
          volume: state.volume,
          isMuted: state.isMuted,
          narrationLanguage: state.narrationLanguage,
          quizLanguage: state.quizLanguage,
          // lifecycle, sessionId, playEdition NOT persisted (always start `idle` on reload)
        }),
      })),
    { name: 'playback-store' }
  )
);

// === Selectors (fine-grained for optimized re-renders) ===

export const useLifecycle = () => usePlaybackStore((s) => s.lifecycle);
export const useIsPlaybackReady = () => usePlaybackStore((s) => s.lifecycle === 'ready');
export const useSessionId = () => usePlaybackStore((s) => s.sessionId);
export const usePlayMode = () => usePlaybackStore((s) => s.playMode);
export const usePlayEdition = () => usePlaybackStore((s) => s.playEdition);
export const useIsPlaying = () => usePlaybackStore((s) => s.isPlaying);
export const useVolume = () => usePlaybackStore((s) => s.volume);
export const useIsMuted = () => usePlaybackStore((s) => s.isMuted);
export const usePlayerPhase = () => usePlaybackStore((s) => s.phase);
export const useCurrentStepIndex = () => usePlaybackStore((s) => s.currentStepIndex);
export const usePendingClickTargetId = () => usePlaybackStore((s) => s.pendingClickTargetId);
export const useReplayableItems = () => usePlaybackStore((s) => s.replayableItems);
export const useEffectLoopRemaining = () => usePlaybackStore((s) => s.effectLoopRemaining);

export const useCurrentStep = () =>
  usePlaybackStore((s) =>
    s.currentStepIndex >= 0 ? s.steps[s.currentStepIndex] ?? null : null
  );

export const useNarrationLanguage = () => usePlaybackStore((s) => s.narrationLanguage);
export const useQuizLanguage = () => usePlaybackStore((s) => s.quizLanguage);
export const useSpreadHistories = () => usePlaybackStore((s) => s.spreadHistories);
export const useCurrentSection = () => usePlaybackStore((s) => s.currentSection);

export const useActiveAnimationOrders = () => usePlaybackStore((s) => s.activeAnimationOrders);
export const useMaxActivatedOrder = () => usePlaybackStore((s) => s.maxActivatedOrder);

/** Spread-turn transition gate — read by `usePlayerGsapEngine` to skip autoplay
 *  effects while a turn is mid-flight (spec §7). */
export const useAutoplaySuspended = () => usePlaybackStore((s) => s.autoplaySuspended);

/**
 * Lifecycle-aware getState — returns `null` if `lifecycle !== 'ready'`.
 *
 * Use this in callbacks/timeline-callbacks/RAF that fire outside React render
 * (e.g. GSAP onComplete) where a stale `usePlaybackStore.getState()` call may
 * land after `teardown()` and mutate idle state. TS forces null-check at every
 * callsite → compile-time guarantee instead of grep-based audit.
 */
export function guardedGetState(): (PlaybackState & PlaybackActions) | null {
  const state = usePlaybackStore.getState();
  if (state.lifecycle !== 'ready') return null;
  return state;
}

export const usePlaybackActions = () =>
  usePlaybackStore(
    useShallow((s) => ({
      initialize: s.initialize,
      teardown: s.teardown,
      play: s.play,
      pause: s.pause,
      setPlayMode: s.setPlayMode,
      setPlayEdition: s.setPlayEdition,
      setNarrationLanguage: s.setNarrationLanguage,
      setQuizLanguage: s.setQuizLanguage,
      setVolume: s.setVolume,
      toggleMute: s.toggleMute,
      reset: s.reset,
      userNext: s.userNext,
      userBack: s.userBack,
      userClick: s.userClick,
      stepComplete: s.stepComplete,
      cancelAndNext: s.cancelAndNext,
      clickLoopReplay: s.clickLoopReplay,
      pushSpreadHistory: s.pushSpreadHistory,
      popSpreadHistory: s.popSpreadHistory,
      clearSpreadHistory: s.clearSpreadHistory,
      setCurrentSection: s.setCurrentSection,
      suspendAutoplay: s.suspendAutoplay,
      resumeAutoplay: s.resumeAutoplay,
    }))
  );

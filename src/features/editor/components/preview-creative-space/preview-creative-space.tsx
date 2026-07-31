// preview-creative-space.tsx — Source-aware preview/playback creative space.
// User picks between Original (snapshot retouch data) or one of the remixes via
// PlayerHeader; spreads, sections, and animations are derived from the chosen
// source. Language fallback + write-back is handled here when the active remix
// does not support the current narrationLanguage.
"use client";

import { useState, useMemo, useEffect, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";
import { PlayerAnimationSidebar } from "./player-animation-sidebar";
import { PlayerHeader } from "./player-header";
import { resolveEffectiveLanguage } from "./resolve-effective-language";
import {
  resolveEffectiveCastSelection,
  castKeyOf,
  applyCastingToSpreads,
} from "./resolve-preview-casting";
import { normalizeCastingSlot } from "@/features/editor/components/config-creative-space/casting-slot-helpers";
import {
  PlayableSpreadView,
  type PlayableSpread,
} from "@/features/editor/components/playable-spread-view";
import {
  resolveAnimations,
  buildItemsMap,
} from "@/features/editor/components/objects-creative-space";
import {
  useRetouchSpreads,
  useSections,
} from "@/stores/snapshot-store/selectors";
import {
  useNarrationLanguage,
  usePlaybackActions,
  useLifecycle,
  type InitializePayload,
} from "@/stores/animation-playback-store";
import { useRemixes, useRemixById } from "@/stores/remix-store";
import {
  useBookTemplateLayout,
  useCurrentBook,
  useBookCastingSlot,
} from "@/stores/book-store";
import { createLogger } from "@/utils/logger";
import type { BaseSpread } from "@/types/spread-types";
import type { Section } from "@/types/illustration-types";
import type { PlayEdition } from "@/types/playable-types";

const log = createLogger("Editor", "PreviewCreativeSpace");

// Human-readable language labels for fallback toast.
const LANG_LABEL: Record<string, string> = {
  vi: "Tiếng Việt",
  vi_VN: "Tiếng Việt",
  en: "English",
  en_US: "English (US)",
  en_GB: "English (UK)",
  ja: "日本語",
  ja_JP: "日本語",
  zh: "中文",
  zh_CN: "中文（简体）",
  fr: "Français",
  fr_FR: "Français",
  es: "Español",
  es_ES: "Español",
  ko: "한국어",
  ko_KR: "한국어",
};

function labelOf(code: string): string {
  return LANG_LABEL[code] ?? code.toUpperCase();
}

export function PreviewCreativeSpace() {
  const narrationLanguage = useNarrationLanguage();
  const templateLayout = useBookTemplateLayout();
  const currentBook = useCurrentBook();
  const bookId = currentBook?.id ?? null;
  const lifecycle = useLifecycle();
  const { initialize, teardown, setNarrationLanguage } = usePlaybackActions();

  // Retry nonce — bumped by error-banner retry button to force payload memo
  // recomputation when `lifecycle === 'error'` and inputs haven't changed.
  const [retryNonce, setRetryNonce] = useState(0);

  // Local source state — Original by default. Decoupled from RemixStore.activeRemixId
  // (Remix space's selection MUST NOT leak into Preview's source picker).
  const [userSelectedRemixId, setUserSelectedRemixId] = useState<string | null>(null);
  const [userSelectedSpreadId, setUserSelectedSpreadId] = useState<string | null>(null);
  // Casting preset overrides — ephemeral, NOT persisted, reset each mount
  // (parity with `userSelectedRemixId`). axisId → presetId (partial override map).
  const [userSelectedPresets, setUserSelectedPresets] = useState<
    Record<string, string>
  >({});

  const remixes = useRemixes();
  const activeRemix = useRemixById(userSelectedRemixId);

  // Unconditional store subs (rule of hooks); pick source in derived useMemo below.
  const retouchSpreads = useRetouchSpreads();
  const retouchSections = useSections();

  // Stale-remix self-heal: if the picked remix was deleted we treat the source
  // as Original via derivation (no setState — avoids react-hooks/set-state-in-effect).
  // The lingering `userSelectedRemixId` is harmless because every downstream
  // derivation keys off `activeRemix` (which is null when stale).
  const effectiveSelectedRemixId = activeRemix ? userSelectedRemixId : null;
  const isStale = userSelectedRemixId !== null && activeRemix === null;
  useEffect(() => {
    if (isStale) {
      log.warn("source.stale", "remix not found, treating as Original", {
        userSelectedRemixId,
      });
    }
  }, [isStale, userSelectedRemixId]);

  // Source-aware derivation. RemixSpread = Omit<BaseSpread, ...> where the omitted
  // fields are all optional in BaseSpread, so the assignment is structurally safe.
  const spreads: BaseSpread[] = useMemo(() => {
    if (activeRemix) return activeRemix.illustration.spreads as BaseSpread[];
    return retouchSpreads;
  }, [activeRemix, retouchSpreads]);

  const sections: Section[] = useMemo(() => {
    // Reshape 2026-07-31: remix illustration is linear (sections optional/[]);
    // tolerate legacy rows AND new rows → player runs pure array order.
    if (activeRemix) return activeRemix.illustration.sections ?? [];
    return retouchSections;
  }, [activeRemix, retouchSections]);

  const spreadIds = useMemo(() => spreads.map((s) => s.id), [spreads]);

  const effectiveSpreadId = useMemo(() => {
    if (userSelectedSpreadId && spreadIds.includes(userSelectedSpreadId)) {
      return userSelectedSpreadId;
    }
    return spreadIds[0] ?? null;
  }, [spreadIds, userSelectedSpreadId]);

  const currentSpread = useMemo(
    () => spreads.find((s) => s.id === effectiveSpreadId) ?? null,
    [spreads, effectiveSpreadId],
  );

  const effectiveLanguage = useMemo(
    () => resolveEffectiveLanguage(activeRemix, narrationLanguage),
    [activeRemix, narrationLanguage],
  );

  const itemsMap = useMemo(
    () => buildItemsMap(currentSpread ?? undefined, effectiveLanguage),
    [currentSpread, effectiveLanguage],
  );

  const resolvedAnimations = useMemo(
    () => resolveAnimations(currentSpread?.animations ?? [], itemsMap),
    [currentSpread, itemsMap],
  );

  const activeRemixId = activeRemix?.id ?? null;

  // === Casting (Preview source = Original only) ===
  // castingAxes memoized on the JSONB REFERENCE (`useBookCastingSlot` returns the
  // store field directly, stable while book unchanged) — normalizeCastingSlot
  // mints a fresh array each call, so without this memo castKey/build re-run every
  // render.
  const bookCastingSlot = useBookCastingSlot();
  const castingAxes = useMemo(
    () => normalizeCastingSlot(bookCastingSlot).casting_axes,
    [bookCastingSlot],
  );

  const effectiveCastSelection = useMemo(
    () =>
      resolveEffectiveCastSelection(
        activeRemixId,
        castingAxes,
        userSelectedPresets,
      ),
    [activeRemixId, castingAxes, userSelectedPresets],
  );
  const castKey = useMemo(
    () => castKeyOf(effectiveCastSelection),
    [effectiveCastSelection],
  );

  // Build clone collapses cast URLs into image fields; layer/preload untouched.
  const playableSpreads = useMemo(
    (): PlayableSpread[] =>
      applyCastingToSpreads(spreads, castingAxes, effectiveCastSelection),
    [spreads, castingAxes, effectiveCastSelection],
  );

  const branchSetting = currentSpread?.branch_setting ?? null;

  // Default edition for this session. Editor has no availableEditions constraint
  // → always pick `interactive` (full feature). Future per-source overrides land here.
  const defaultEdition: PlayEdition = "interactive";

  // === Lifecycle: build payload + dispatch initialize ===
  // useLayoutEffect runs sync after DOM mutation but BEFORE paint and before
  // child useEffect — guarantees child sees `lifecycle === 'ready'` on first
  // effect tick, eliminating the parent/child effect-order race that motivated
  // this refactor (see ADR-030 / plan 260514-1542).
  //
  // Deps intentionally exclude:
  // - `effectiveSpreadId`: spread navigation is in-session — re-`initialize`
  //   would wipe `steps`/`spreadHistories`/`phase`, clobbering user state. The
  //   `startSpreadId` is only a seed for FIRST init in a session.
  // - `effectiveLanguage`: language changes go through `setNarrationLanguage`
  //   (user-pref action, unguarded). Re-`initialize` on language change would
  //   also clobber playback state.
  // castKey folds into sessionId so a preset switch (Original source) re-inits the
  // session (new preload key + fresh playback state). `castKey` is a string ⇒ safe
  // memo dep. Deps STILL exclude `effectiveSpreadId` — see the block comment above;
  // the current spread is preserved via `latestSpreadIdRef` at dispatch time.
  const firstSpreadId = spreadIds[0] ?? null;
  const payload: InitializePayload | null = useMemo(() => {
    if (!bookId || !firstSpreadId) return null;
    const sessionId = activeRemixId
      ? `remix:${activeRemixId}`
      : `original:${bookId}` + (castKey ? `:cast:${castKey}` : "");
    return {
      sessionId,
      language: effectiveLanguage,
      edition: defaultEdition,
      availableEditions: undefined, // editor = no constraint = all editions
      startSpreadId: firstSpreadId, // seed only; overridden by ref at dispatch
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, activeRemixId, firstSpreadId, castKey, retryNonce]);

  // Keep the current spread across a session re-init (preset switch). Reading the
  // spread at DISPATCH time (via ref) — instead of adding `effectiveSpreadId` to
  // `payload` deps — avoids re-initializing on in-session spread navigation (which
  // would wipe steps/spreadHistories/phase). This effect MUST be declared BEFORE
  // the lifecycle effect below so the ref is fresh when initialize() runs.
  const latestSpreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    latestSpreadIdRef.current = effectiveSpreadId;
  }, [effectiveSpreadId]);

  // Single lifecycle effect: initialize on mount/session-switch, teardown on
  // unmount/session-switch. Effective key is `payload.sessionId` (changes when
  // user switches between original/remix or book). Same-session re-fires
  // absorbed by the store's idempotent guard inside `initialize`.
  useLayoutEffect(() => {
    if (!payload) return;
    initialize({
      ...payload,
      startSpreadId: latestSpreadIdRef.current ?? payload.startSpreadId,
    });
    return () => {
      teardown();
    };
  }, [payload, initialize, teardown]);

  // Trade-off (accepted per spec): switching preset while playing re-inits the
  // session → loses playback progress WITHIN the current spread. The spread itself
  // is preserved (ref above). Casting is a deliberate action; no disabled guard.
  const handlePresetSelect = (axisId: string, presetId: string | null) => {
    log.info("casting.preset.select", "override changed", { axisId, presetId });
    setUserSelectedPresets((prev) => {
      if (presetId === null) {
        if (!(axisId in prev)) return prev; // keep reference
        const { [axisId]: _drop, ...rest } = prev;
        return rest;
      }
      if (prev[axisId] === presetId) return prev; // no-op keep reference
      return { ...prev, [axisId]: presetId };
    });
  };

  // Language fallback write-back + toast. Only fires on transition; the guard
  // (effectiveLanguage === narrationLanguage after write-back) prevents looping.
  // `setNarrationLanguage` is NOT lifecycle-guarded (user preference) — safe pre-init.
  useEffect(() => {
    if (activeRemix === null) return;
    if (effectiveLanguage === narrationLanguage) return;

    setNarrationLanguage(effectiveLanguage);

    log.info("language.fallback", "transition + write-back", {
      remixId: activeRemix.id,
      requested: narrationLanguage,
      applied: effectiveLanguage,
    });

    toast.info(
      `Showing in ${labelOf(effectiveLanguage)} — "${activeRemix.name}" doesn't support ${labelOf(narrationLanguage)}`,
    );
  }, [activeRemix, effectiveLanguage, narrationLanguage, setNarrationLanguage]);

  log.debug("render", "derived", {
    source: activeRemix ? "remix" : "original",
    remixId: activeRemix?.id ?? null,
    spreadCount: spreads.length,
    effectiveLanguage,
    hasBranch: !!branchSetting,
    castKey,
    axisCount: castingAxes.length,
  });

  if (spreadIds.length === 0) {
    return (
      <div className="flex h-full overflow-hidden">
        <PlayerAnimationSidebar
          animations={resolvedAnimations}
          branchSetting={branchSetting}
        />
        <div className="flex flex-1 flex-col overflow-hidden">
          <PlayerHeader
            remixes={remixes}
            selectedRemixId={effectiveSelectedRemixId}
            onSelect={setUserSelectedRemixId}
            castingAxes={castingAxes}
            selectedPresets={userSelectedPresets}
            onPresetSelect={handlePresetSelect}
          />
          <div className="flex flex-1 items-center justify-center">
            <p className="text-muted-foreground">No spreads available for preview</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <PlayerAnimationSidebar
        animations={resolvedAnimations}
        branchSetting={branchSetting}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <PlayerHeader
          remixes={remixes}
          selectedRemixId={effectiveSelectedRemixId}
          onSelect={setUserSelectedRemixId}
          castingAxes={castingAxes}
          selectedPresets={userSelectedPresets}
          onPresetSelect={handlePresetSelect}
        />
        {lifecycle === "error" && (
          <div className="bg-destructive/10 text-destructive border-b border-destructive/30 px-4 py-2 text-sm flex items-center justify-between">
            <span>
              Không thể khởi tạo playback — dữ liệu sách chưa sẵn sàng.
            </span>
            <button
              type="button"
              onClick={() => setRetryNonce((n) => n + 1)}
              className="ml-3 px-3 py-1 rounded bg-destructive text-destructive-foreground text-xs font-medium hover:opacity-90"
            >
              Thử lại
            </button>
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <PlayableSpreadView
            spreads={playableSpreads}
            sections={sections}
            onSpreadSelect={setUserSelectedSpreadId}
            pageNumbering={templateLayout?.page_numbering}
            sourceKey={payload?.sessionId}
          />
        </div>
      </div>
    </div>
  );
}

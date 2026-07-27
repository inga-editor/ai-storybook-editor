// cost.ts — Types for the book AI-cost breakdown (`GET /api/cost/book-breakdown/{bookId}`).
//
// Spec (authoritative): ai-storybook-design/api/cost/01-get-book-cost-breakdown.md §Result
// Consumers: CostBreakdownModal (01-01-cost-breakdown-modal.md) + EditorHeader menu Cost row.
//
// Shapes are copied 1-1 from the spec — do NOT prune fields that the current UI does not read
// yet (`meta.pricingVersions`, `meta.rowCount`): they are the drift signals the modal/ops rely on.

/** One leaf of the sparse `(action × model)` matrix of a scope, already aggregated server-side.
 *  `costUsd` is rounded to 2 decimals AT THE CELL — the client must never re-round or re-sum
 *  from row level, otherwise `Σ children === group` stops holding to the cent. */
export interface CostCell {
  /** Stable key: 'generate' | 'regenerate' | 'remove-bg' | 'segment' | ... | 'other'. */
  actionKey: string;
  /** Server-resolved display label ('Generate', 'Remove BG', ...) — i18n-ready. */
  actionLabel: string;
  /** Raw `ai_service_logs.model` — stable dedupe key, not for display. */
  modelKey: string;
  /** Pretty label ('Nano Banana', 'SAM 3', ...); falls back to `modelKey` when unmapped. */
  modelLabel: string;
  /** 'gemini' | 'replicate' | 'elevenlabs' — typed wide on purpose (new providers ship BE-first). */
  provider: string;
  costUsd: number;
  callCount: number;
}

/** One billing scope of a book: Original, or one Remix. Remix cost is NEVER folded into
 *  Original (`remix_id` is the discriminator — ADR-050). */
export interface CostScope {
  /** 'original' | '<remixId>'. */
  key: string;
  /** 'Original' | `remixes.name` (fallback 'Remix {n}'). */
  label: string;
  /** null ⇔ `key === 'original'`. */
  remixId: string | null;
  /** = Σ `cells[].costUsd`. The modal's Total row reads THIS, it does not re-sum. */
  totalCostUsd: number;
  callCount: number;
  /** Rows with `status='error'` — still billed (providers charge per run). Surfaced as a footnote. */
  errorCount: number;
  /** Rows with `cost_usd IS NULL` (model outside the pricing table) — NOT added to the total,
   *  so a value > 0 means the displayed total is LOWER than reality. Must be shown in the UI. */
  unpricedCallCount: number;
  /** Sorted server-side: costUsd DESC, tie → actionKey ASC, modelKey ASC. */
  cells: CostCell[];
}

/** `data` payload — also the `initialData` shape the header prefetches for the modal. */
export interface BookCostBreakdown {
  bookId: string;
  /** Constant for now — kept in the contract so multi-currency is additive later. */
  currency: 'USD';
  /** `scopes[0]` is ALWAYS 'original', even when its cost is 0. */
  scopes: CostScope[];
  /** Σ of every scope. ⚡ The header row shows `scopes[0].totalCostUsd`, NOT this. */
  grandTotalUsd: number;
  /** ISO-8601 `max(created_at)` across the whole book; null when the book has no AI calls. */
  lastCallAt: string | null;
}

/** Response `meta` — data-quality signals. `truncated` MUST be rendered (silent missing data is
 *  worse than no data); `pricingVersions.length > 1` means the numbers span several price tables. */
export interface BookCostBreakdownMeta {
  pricingVersions: string[];
  rowCount: number;
  truncated: boolean;
}

/** Raw success envelope returned by the endpoint. */
export interface GetBookCostBreakdownResult {
  success: true;
  data: BookCostBreakdown;
  meta: BookCostBreakdownMeta;
}

/** Which dimension of the `(action × model)` matrix becomes the group row. The two modes are
 *  transposes of the SAME cells — no refetch when switching. */
export type CostGroupBy = 'action' | 'model';

/** Leaf row of a pivoted group (the other dimension of `CostGroupBy`). */
export interface CostGroupChild {
  key: string;
  label: string;
  costUsd: number;
  callCount: number;
}

/** Client-side pivot result (Phase 03 produces this from `CostScope.cells`).
 *  Invariant: `costUsd === Σ children[].costUsd`, in BOTH group modes. Groups always render
 *  their children, even a single one. */
export interface CostGroup {
  key: string;
  label: string;
  costUsd: number;
  children: CostGroupChild[];
}

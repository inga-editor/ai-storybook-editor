// canvas-types.ts - Domain types for canvas spread view

import type { RefObject } from "react";

// === Canvas Dimension Types (cross-module, used by constants/utils/store/components) ===
export interface CanvasSize {
  width: number;
  height: number;
}

// ⚡ ADR-023: Bleed-relative coordinate space.
// Canvas [0, 100] = full bleed (tờ giấy vật lý trước khi xén).
// Trim là vùng advisory bên trong ở [trimPct, 100-trimPct] — không clip, chỉ render dashed guide.
export interface BleedCanvasSize {
  full: CanvasSize;  // Full canvas = trim + bleed 2 cạnh (editor/reader/print đều dùng)
  trim: CanvasSize;  // Vùng in an toàn (bên trong full, chỉ để compute trim guide)
  /** Bleed width/height as % of full canvas — used to position trim guide at [trimPct, 100-trimPct] */
  trimPct: { x: number; y: number };
}
import type {
  Point,
  Geometry,
  Typography,
  ShapeFill,
  ShapeOutline,
  SpreadShape,
  SpreadVideo,
  SpreadAutoPic,
  SpreadAudio,
  SpreadAutoAudio,
  SpreadQuiz,
  PageData,
  SpreadImage,
  SpreadTextbox,
  BaseSpread,
  ItemType,
} from './spread-types';

// === Enums & Literals ===
export type ViewMode = "edit" | "grid";
export type SelectedElementType =
  | "image"
  | "textbox"
  | "raw_image"
  | "raw_textbox"
  | "shape"
  | "video"
  | "auto_pic"
  | "audio"
  | "auto_audio"
  | "quiz"
  | "composite"
  | "page";
export type ResizeHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
export type ThumbnailListLayout = "horizontal" | "grid";
export type TextureOption = "paper" | "canvas" | "linen" | "watercolor" | null;

export interface LayoutOption {
  id: string;
  title: string;
  thumbnail_url: string;
  type: 1 | 2;
}

// === Selection State ===
export interface SelectedElement {
  type: SelectedElementType;
  index: number;
}

// === Spread Item Action Types ===
export type SpreadItemType = 'page' | 'image' | 'textbox' | 'shape' | 'video' | 'auto_pic' | 'audio' | 'auto_audio' | 'quiz' | 'composite';
export type SpreadItemActionType = 'add' | 'update' | 'delete';

export interface SpreadItemActionParams<TData = unknown> {
  spreadId: string;
  itemType: SpreadItemType;
  action: SpreadItemActionType;
  itemId: number | string | null;  // page index: number, other id: string, null for add
  data: TData | null;     // null for delete
}

// Image actions (itemId: string = UUID)
export type ImageAddAction = SpreadItemActionParams<SpreadImage> & {
  itemType: 'image';
  action: 'add';
  itemId: null;
};

export type ImageUpdateAction = SpreadItemActionParams<Partial<SpreadImage>> & {
  itemType: 'image';
  action: 'update';
  itemId: string;
};

export type ImageDeleteAction = SpreadItemActionParams<null> & {
  itemType: 'image';
  action: 'delete';
  itemId: string;
  data: null;
};

// Textbox actions (itemId: string = UUID)
export type TextboxAddAction = SpreadItemActionParams<SpreadTextbox> & {
  itemType: 'textbox';
  action: 'add';
  itemId: null;
};

export type TextboxUpdateAction = SpreadItemActionParams<Partial<SpreadTextbox>> & {
  itemType: 'textbox';
  action: 'update';
  itemId: string;
};

export type TextboxDeleteAction = SpreadItemActionParams<null> & {
  itemType: 'textbox';
  action: 'delete';
  itemId: string;
  data: null;
};

// Shape actions (itemId: string = UUID)
export type ShapeAddAction = SpreadItemActionParams<SpreadShape> & {
  itemType: 'shape';
  action: 'add';
  itemId: null;
};

export type ShapeUpdateAction = SpreadItemActionParams<Partial<SpreadShape>> & {
  itemType: 'shape';
  action: 'update';
  itemId: string;
};

export type ShapeDeleteAction = SpreadItemActionParams<null> & {
  itemType: 'shape';
  action: 'delete';
  itemId: string;
  data: null;
};

// Video actions (itemId: string = UUID)
export type VideoAddAction = SpreadItemActionParams<SpreadVideo> & {
  itemType: 'video';
  action: 'add';
  itemId: null;
};

export type VideoUpdateAction = SpreadItemActionParams<Partial<SpreadVideo>> & {
  itemType: 'video';
  action: 'update';
  itemId: string;
};

export type VideoDeleteAction = SpreadItemActionParams<null> & {
  itemType: 'video';
  action: 'delete';
  itemId: string;
  data: null;
};

// AutoPic actions (itemId: string = UUID)
export type AutoPicAddAction = SpreadItemActionParams<SpreadAutoPic> & {
  itemType: 'auto_pic';
  action: 'add';
  itemId: null;
};

export type AutoPicUpdateAction = SpreadItemActionParams<Partial<SpreadAutoPic>> & {
  itemType: 'auto_pic';
  action: 'update';
  itemId: string;
};

export type AutoPicDeleteAction = SpreadItemActionParams<null> & {
  itemType: 'auto_pic';
  action: 'delete';
  itemId: string;
  data: null;
};

// Audio actions (itemId: string = UUID)
export type AudioAddAction = SpreadItemActionParams<SpreadAudio> & {
  itemType: 'audio';
  action: 'add';
  itemId: null;
};

export type AudioUpdateAction = SpreadItemActionParams<Partial<SpreadAudio>> & {
  itemType: 'audio';
  action: 'update';
  itemId: string;
};

export type AudioDeleteAction = SpreadItemActionParams<null> & {
  itemType: 'audio';
  action: 'delete';
  itemId: string;
  data: null;
};

// AutoAudio actions (itemId: string = UUID)
export type AutoAudioAddAction = SpreadItemActionParams<SpreadAutoAudio> & {
  itemType: 'auto_audio';
  action: 'add';
  itemId: null;
};

export type AutoAudioUpdateAction = SpreadItemActionParams<Partial<SpreadAutoAudio>> & {
  itemType: 'auto_audio';
  action: 'update';
  itemId: string;
};

export type AutoAudioDeleteAction = SpreadItemActionParams<null> & {
  itemType: 'auto_audio';
  action: 'delete';
  itemId: string;
  data: null;
};

// Quiz actions (itemId: string = UUID)
export type QuizAddAction = SpreadItemActionParams<SpreadQuiz> & {
  itemType: 'quiz';
  action: 'add';
  itemId: null;
};

export type QuizUpdateAction = SpreadItemActionParams<Partial<Omit<SpreadQuiz, 'id' | 'type'>>> & {
  itemType: 'quiz';
  action: 'update';
  itemId: string;
};

export type QuizDeleteAction = SpreadItemActionParams<null> & {
  itemType: 'quiz';
  action: 'delete';
  itemId: string;
  data: null;
};

// Page actions (itemId: number = page index 0|1)
export type PageUpdateAction = SpreadItemActionParams<Partial<PageData>> & {
  itemType: 'page';
  action: 'update';
  itemId: number;
};

// Union of all actions
export type SpreadItemActionUnion =
  | ImageAddAction
  | ImageUpdateAction
  | ImageDeleteAction
  | TextboxAddAction
  | TextboxUpdateAction
  | TextboxDeleteAction
  | ShapeAddAction
  | ShapeUpdateAction
  | ShapeDeleteAction
  | VideoAddAction
  | VideoUpdateAction
  | VideoDeleteAction
  | AutoPicAddAction
  | AutoPicUpdateAction
  | AutoPicDeleteAction
  | AudioAddAction
  | AudioUpdateAction
  | AudioDeleteAction
  | AutoAudioAddAction
  | AutoAudioUpdateAction
  | AutoAudioDeleteAction
  | QuizAddAction
  | QuizUpdateAction
  | QuizDeleteAction
  | PageUpdateAction;

// Handler type
export type OnUpdateSpreadItemFn = (params: SpreadItemActionUnion) => void;

// Re-export spread types that canvas consumers commonly need
export type {
  Point,
  Geometry,
  Typography,
  ShapeFill,
  ShapeOutline,
  SpreadShape,
  SpreadVideo,
  SpreadAutoPic,
  SpreadAudio,
  SpreadAutoAudio,
  SpreadQuiz,
  PageData,
  SpreadImage,
  SpreadTextbox,
  BaseSpread,
  ItemType,
};

// === Context Interfaces (shared across canvas component group) ===
export interface BaseItemContext<TSpread extends BaseSpread> {
  item: unknown;
  itemIndex: number;
  spreadId: string;
  spread: TSpread;
  isSelected: boolean;
  isSpreadSelected: boolean;
  /** Resolved z-index for rendering order on the canvas */
  zIndex?: number;
  /** ADR-029 — canvas-level controlled hover (smart hit-test in Objects space). */
  isHoveredByCanvas?: boolean;
  /** ADR-029 — item dims when fully covering a lower-z selected item. */
  dimmedByOverlap?: boolean;
}

export interface ImageItemContext<TSpread extends BaseSpread>
  extends BaseItemContext<TSpread> {
  item: SpreadImage;
  onSelect: () => void;
  onUpdate: (updates: Partial<SpreadImage>) => void;
  onDelete: () => void;
  onArtNoteChange?: (artNote: string) => void;
  onEditingChange?: (isEditing: boolean) => void;
  /** Controlled edit mode — when set, parent (SpreadEditorPanel) owns editing state.
   *  Only used by spaces with inline image editing (dummy art-note). */
  isEditing?: boolean;
}

export interface TextItemContext<TSpread extends BaseSpread>
  extends BaseItemContext<TSpread> {
  item: SpreadTextbox;
  onSelect: () => void;
  onTextChange: (text: string) => void;
  onUpdate: (updates: Partial<SpreadTextbox>) => void;
  onDelete: () => void;
  onEditingChange?: (isEditing: boolean) => void;
  /** Controlled edit mode — when set, parent (SpreadEditorPanel) owns editing state */
  isEditing?: boolean;
}

export interface ShapeItemContext<TSpread extends BaseSpread>
  extends BaseItemContext<TSpread> {
  item: SpreadShape;
  onSelect: () => void;
  onUpdate: (updates: Partial<SpreadShape>) => void;
  onDelete: () => void;
}

export interface VideoItemContext<TSpread extends BaseSpread>
  extends BaseItemContext<TSpread> {
  item: SpreadVideo;
  isThumbnail?: boolean;
  onSelect: () => void;
  onUpdate: (updates: Partial<SpreadVideo>) => void;
  onDelete: () => void;
}

export interface AutoPicItemContext<TSpread extends BaseSpread>
  extends BaseItemContext<TSpread> {
  item: SpreadAutoPic;
  isThumbnail?: boolean;
  onSelect: () => void;
  onUpdate: (updates: Partial<SpreadAutoPic>) => void;
  onDelete: () => void;
}

export interface AudioItemContext<TSpread extends BaseSpread>
  extends BaseItemContext<TSpread> {
  item: SpreadAudio;
  isThumbnail?: boolean;
  onSelect: () => void;
  onUpdate: (updates: Partial<SpreadAudio>) => void;
  onDelete: () => void;
}

export interface AutoAudioItemContext<TSpread extends BaseSpread>
  extends BaseItemContext<TSpread> {
  item: SpreadAutoAudio;
  isThumbnail?: boolean;
  onSelect: () => void;
  onUpdate: (updates: Partial<SpreadAutoAudio>) => void;
  onDelete: () => void;
}

export interface QuizItemContext<TSpread extends BaseSpread>
  extends BaseItemContext<TSpread> {
  item: SpreadQuiz;
  onSelect: () => void;
  onUpdate: (updates: Partial<Omit<SpreadQuiz, 'id' | 'type'>>) => void;
  onDelete: () => void;
}

// === Toolbar Contexts ===
export interface BaseToolbarContext {
  selectedGeometry: Geometry | null;
  canvasRef: RefObject<HTMLDivElement | null>;
}

export interface PageToolbarContext<TSpread extends BaseSpread> {
  page: PageData;
  pageIndex: number;
  position: "left" | "right" | "single";
  spread: TSpread;
  spreadId: string;
  isSelected: boolean;
  onUpdateLayout: (layoutId: string) => void;
  onUpdateColor: (color: string) => void;
  onUpdateTexture: (texture: TextureOption) => void;
  availableLayouts: LayoutOption[];
  availableTextures: TextureOption[];
  isLayoutLocked: boolean;
}

export interface ImageToolbarContext<TSpread extends BaseSpread>
  extends ImageItemContext<TSpread>,
    BaseToolbarContext {
  onGenerateImage: () => void;
  /** Open the consolidated EditImageModal (Inpaint / Outpaint / Upscale / Remove BG / Erasor).
   *  Added in the per-space toolbar unify (matrix); space passes `enabledTools`. */
  onEditImage?: () => void;
  /** Open the consolidated ExtractImageModal (Objects / Segments / Layers / Background). */
  onExtractImage?: () => void;
  onReplaceImage: () => void;
  onClone?: () => void;
  /** Open the item slot modal (init) or route to the edit-slot modal when the item
   *  already carries a slot. Owner: ObjectsMainView. Absent → toolbar shows "Coming soon". */
  onConfigureSlot?: () => void;
  /** Trigger inline edit mode for the selected image — set by parent via editingItemId state.
   *  Only meaningful for spaces with inline image editing (dummy art-note). */
  onEditArtNote?: () => void;
}

export interface TextToolbarContext<TSpread extends BaseSpread>
  extends TextItemContext<TSpread>,
    BaseToolbarContext {
  onFormatText: (format: Partial<Typography>) => void;
  onClone?: () => void;
  onSplitTextbox?: () => void;
  /** Trigger edit mode for the selected textbox — set by parent via editingItemId state */
  onEditText?: () => void;
}

export interface ShapeToolbarContext<TSpread extends BaseSpread>
  extends ShapeItemContext<TSpread>,
    BaseToolbarContext {
  onUpdateFill: (fill: Partial<ShapeFill>) => void;
  onUpdateOutline: (outline: Partial<ShapeOutline>) => void;
  onClone?: () => void;
}

export interface VideoToolbarContext<TSpread extends BaseSpread>
  extends VideoItemContext<TSpread>,
    BaseToolbarContext {
  onReplaceVideo: () => void;
}

export interface AutoPicToolbarContext<TSpread extends BaseSpread>
  extends AutoPicItemContext<TSpread>,
    BaseToolbarContext {
  onReplaceAutoPic: () => void;
}

export interface AudioToolbarContext<TSpread extends BaseSpread>
  extends AudioItemContext<TSpread>,
    BaseToolbarContext {
  onBrowseSound: () => void;
  onEditAudio?: () => void;
}

export interface AutoAudioToolbarContext<TSpread extends BaseSpread>
  extends AutoAudioItemContext<TSpread>,
    BaseToolbarContext {
  onBrowseSound: () => void;
  onEditAudio?: () => void;
}

export interface QuizToolbarContext<TSpread extends BaseSpread>
  extends QuizItemContext<TSpread>,
    BaseToolbarContext {
  onEditQuiz: () => void;
}

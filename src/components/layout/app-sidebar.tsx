import { useCallback, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  FolderKanban,
  FolderOpen,
  Users,
  Swords,
  Lightbulb,
  Music,
  AudioLines,
  Mic,
  Palette,
  Smile,
  User,
  Repeat,
  Video,
  ListTree,
  Clock,
  MapPin,
  Sparkles,
  Drama,
  FileText,
  LayoutTemplate,
  UserCog,
  ChevronDown,
  ChevronUp,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentProfile } from "@/features/users/hooks/use-current-profile";
import { createLogger } from "@/utils/logger";
import { cn } from "@/utils/utils";

const log = createLogger("Layout", "AppSidebar");

// ---------------------------------------------------------------------------
// Nav config — single source of truth for grouping + order (design README §1.3)
// ---------------------------------------------------------------------------

type SectionKey = "creatives" | "library" | "personalization" | "tools" | "other";

interface NavItemConfig {
  key: string;
  to: string;
  icon: LucideIcon;
  label: string;
  /** Admin-only destination — rendered disabled + tooltip for non-admins. */
  adminOnly?: boolean;
}

interface NavSectionConfig {
  key: SectionKey;
  label: string;
  /** Fallback open-state when no user override AND not the active section. */
  defaultOpen: boolean;
  items: NavItemConfig[];
}

const NAV_SECTIONS: NavSectionConfig[] = [
  {
    key: "creatives",
    label: "CREATIVES",
    defaultOpen: false,
    items: [
      { key: "projects", to: "/projects", icon: FolderKanban, label: "Projects" },
    ],
  },
  {
    key: "library",
    label: "LIBRARY",
    defaultOpen: false,
    items: [
      { key: "assets", to: "/assets", icon: FolderOpen, label: "Assets" },
      { key: "characters", to: "/characters", icon: Users, label: "Characters" },
      { key: "props", to: "/props", icon: Swords, label: "Props" },
      { key: "concepts", to: "/concepts", icon: Lightbulb, label: "Concepts" },
      { key: "sounds", to: "/sounds", icon: Music, label: "Sounds" },
      { key: "musics", to: "/musics", icon: AudioLines, label: "Musics" },
      { key: "voices", to: "/voices", icon: Mic, label: "Voices" },
      { key: "styles", to: "/styles", icon: Palette, label: "Styles" },
    ],
  },
  {
    key: "personalization",
    label: "PERSONALIZATION",
    defaultOpen: false,
    items: [
      { key: "items", to: "/items", icon: Smile, label: "Items" },
      { key: "humans", to: "/humans", icon: User, label: "Humans" },
      { key: "remixes", to: "/remixes", icon: Repeat, label: "Remixes" },
    ],
  },
  {
    key: "tools",
    label: "TOOLS",
    defaultOpen: false,
    items: [{ key: "videos", to: "/videos", icon: Video, label: "Videos" }],
  },
  {
    key: "other",
    label: "OTHER",
    defaultOpen: false,
    items: [
      { key: "categories", to: "/categories", icon: ListTree, label: "Categories" },
      { key: "eras", to: "/eras", icon: Clock, label: "Eras" },
      { key: "locations", to: "/locations", icon: MapPin, label: "Locations" },
      { key: "themes", to: "/themes", icon: Sparkles, label: "Themes" },
      { key: "genres", to: "/genres", icon: Drama, label: "Genres" },
      { key: "formats", to: "/formats", icon: FileText, label: "Formats" },
      { key: "layouts", to: "/layouts", icon: LayoutTemplate, label: "Layouts" },
      { key: "users", to: "/users", icon: UserCog, label: "Users", adminOnly: true },
    ],
  },
];

const SECTIONS_STORAGE_KEY = "app-sidebar:sections";

type SectionOverrides = Partial<Record<SectionKey, boolean>>;

/** Reverse-lookup the section owning `pathname` (prefix match for nested routes). */
function sectionOf(pathname: string): SectionKey | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (pathname === item.to || pathname.startsWith(item.to + "/")) {
        return section.key;
      }
    }
  }
  return null;
}

/** Seed overrides from localStorage. Any parse/shape failure → all-default ({}). */
function readSectionOverrides(): SectionOverrides {
  try {
    const raw = localStorage.getItem(SECTIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SectionOverrides;
    }
    log.warn("readSectionOverrides", "unexpected shape, falling back", { raw });
    return {};
  } catch (err) {
    log.warn("readSectionOverrides", "parse failed, falling back", {
      error: String(err),
    });
    return {};
  }
}

const NAV_ITEM_BASE_CLASS =
  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors";

// ---------------------------------------------------------------------------
// AppSidebar
// ---------------------------------------------------------------------------

export function AppSidebar() {
  const { user, isAuthenticated } = useAuthStore();
  // Own role for admin-only nav gating (UX only; the /api/users endpoints are
  // the authoritative gate). Non-admins see the item DISABLED, never hidden.
  const { role, isLoading: isRoleLoading } = useCurrentProfile();
  const isAdmin = role === "admin";

  const { pathname } = useLocation();
  const activeSectionKey = sectionOf(pathname);

  // Only sections the user actively toggled live here; the rest derive from
  // (active || defaultOpen). Seeded once from localStorage (lazy init — never in
  // an effect: repo lints set-state-in-effect as an error).
  const [sectionOverrides, setSectionOverrides] = useState<SectionOverrides>(
    readSectionOverrides
  );

  const toggleSection = useCallback((key: SectionKey, nextOpen: boolean) => {
    setSectionOverrides((prev) => {
      const next = { ...prev, [key]: nextOpen };
      try {
        localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(next));
      } catch (err) {
        // Best-effort persistence — private mode / quota should not break toggle.
        log.warn("toggleSection", "persist failed", { key, error: String(err) });
      }
      return next;
    });
    log.debug("toggleSection", "section toggled", { key, nextOpen });
  }, []);

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-sidebar-border bg-sidebar-background">
      <div className="p-4">
        <NavLink to="/home" className="text-xl font-bold text-foreground">
          StoryWeaver
        </NavLink>
      </div>

      <nav
        aria-label="Main navigation"
        className="flex-1 space-y-1 overflow-y-auto px-3 py-2"
      >
        {NAV_SECTIONS.map((section) => {
          // Derive-only (design §2.3): override wins over auto-expand → use `??`.
          const open =
            section.key in sectionOverrides
              ? Boolean(sectionOverrides[section.key])
              : section.key === activeSectionKey || section.defaultOpen;

          return (
            <NavSection
              key={section.key}
              section={section}
              isOpen={open}
              isAdmin={isAdmin}
              isRoleLoading={isRoleLoading}
              onToggle={() => toggleSection(section.key, !open)}
            />
          );
        })}
      </nav>

      {isAuthenticated && user ? (
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-9 w-9">
              <AvatarFallback
                className="bg-primary text-primary-foreground"
                aria-label={user.name}
              >
                {user.name.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 truncate">
              <p className="text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {user.email}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="border-t border-sidebar-border p-4">
          <NavLink to="/login">
            <Button variant="outline" className="w-full">
              Sign In
            </Button>
          </NavLink>
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// NavSection — controlled collapse (parent owns open-state); renders header +
// item list. Items unmount when collapsed.
// ---------------------------------------------------------------------------

interface NavSectionProps {
  section: NavSectionConfig;
  isOpen: boolean;
  isAdmin: boolean;
  isRoleLoading: boolean;
  onToggle: () => void;
}

function NavSection({
  section,
  isOpen,
  isAdmin,
  isRoleLoading,
  onToggle,
}: NavSectionProps) {
  const listId = `nav-section-${section.key}`;
  const Chevron = isOpen ? ChevronUp : ChevronDown;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={listId}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <span>{section.label}</span>
        <Chevron className="h-4 w-4" aria-hidden="true" />
      </button>

      {isOpen && (
        <div id={listId} className="mt-1 space-y-1">
          {section.items.map((item) => {
            const disabledReason =
              item.adminOnly && !isAdmin
                ? isRoleLoading
                  ? "Checking access…"
                  : "Admins only"
                : null;
            return (
              <NavItem
                key={item.key}
                item={item}
                disabledReason={disabledReason}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NavItem — one NavLink (active class + aria-current handled by react-router).
// When `disabledReason` is set, renders a non-navigable span + tooltip instead.
// ---------------------------------------------------------------------------

interface NavItemProps {
  item: NavItemConfig;
  disabledReason: string | null;
}

function NavItem({ item, disabledReason }: NavItemProps) {
  const Icon = item.icon;

  if (disabledReason) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="link"
              aria-disabled="true"
              tabIndex={0}
              className={cn(
                NAV_ITEM_BASE_CLASS,
                "cursor-not-allowed text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{disabledReason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          NAV_ITEM_BASE_CLASS,
          isActive
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        )
      }
    >
      <Icon className="h-5 w-5" />
      {item.label}
    </NavLink>
  );
}

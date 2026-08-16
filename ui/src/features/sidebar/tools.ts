import {
  GearIcon,
  InfoIcon,
  ListNumbersIcon,
  MetronomeIcon,
  PackageIcon,
  RepeatIcon,
} from 'phosphor-svelte';
import type { ToolId } from '../../lib/engine/types';

/** One rail icon per entry. The panel body stays an explicit branch in
    ToolSidebar — each tool needs bespoke props — so adding a tool is one
    entry here plus one branch there (and a ToolId union member). */
export interface ToolDef {
  id: ToolId;
  label: string;
  icon: typeof RepeatIcon;
  /** Docked panel width (a CSS length). Each panel declares the width its
      content needs, kept as tight as its widest row allows — the panel eats
      the rack, which is the thing the player is actually looking at. */
  width: string;
  /** Whether the panel offers the maximize (stage view) button. Performance
      looper earns it — its state must be readable from standing distance;
      the utility panels are read at the desk, docked. */
  canMaximize: boolean;
}

/** Performance tools, pinned to the rail's top. */
export const TOOLS: readonly ToolDef[] = [
  { id: 'looper', label: 'Looper', icon: RepeatIcon, width: '20rem', canMaximize: true },
  { id: 'metronome', label: 'Metronome', icon: MetronomeIcon, width: '20rem', canMaximize: true },
  // Labelled for the library, not the setlists: a set is optional, the book of
  // songs is not, and that is the surface the panel opens on. Wider than the
  // other two by the length of a song title.
  { id: 'setlist', label: 'Songs', icon: ListNumbersIcon, width: '22rem', canMaximize: true },
];

/** Set-once panels, pinned to the rail's bottom (array order is render
    order, so Settings sits bottom-most). Same panel mechanics as the tools
    above; the split is purely visual — reach-for-mid-song up top, configure-
    and-forget down where every app keeps its gear icon. */
export const UTILITY_TOOLS: readonly ToolDef[] = [
  // The widest of the three, and for two reasons that both arrived with the
  // filter bar. A row is a plugin's name over what it is for, and that second
  // line is a phrase ("Gate, compressor, EQ, delay and more") rather than a
  // setting's one-word label — now clamped to two lines instead of truncated,
  // which the width decides the cost of. Above it sit four view segments and a
  // row of section chips, both of which wrap into something scruffy before they
  // break. Version, licence and project link still live behind the row's menu,
  // so nothing else competes for it.
  // Labelled "Packages", not "Plugins": the panel offers cabinet IRs and other
  // content alongside VST3s, and the rack's own plugin list is a different
  // thing entirely. The id stays `plugins` — it is persisted in settings.json
  // as the active tool, so renaming it would drop everyone's open panel. A box
  // rather than a plug for the same reason: a plug is a plugin, and half of
  // what this panel downloads is not one.
  { id: 'plugins', label: 'Packages', icon: PackageIcon, width: '26rem', canMaximize: false },
  // The one panel that stays wide: the diagnostics report is a two-column
  // monospace table, and wrapping a device name mid-path makes it unreadable
  // in the exact situation someone opens it.
  { id: 'info', label: 'Info & stats', icon: InfoIcon, width: '30rem', canMaximize: false },
  { id: 'settings', label: 'Settings', icon: GearIcon, width: '18rem', canMaximize: false },
];

<script lang="ts">
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import {
    CircleNotchIcon,
    PowerIcon,
    ArrowSquareOutIcon,
    TrashIcon,
    GaugeIcon,
    ArrowsInLineVerticalIcon,
    ArrowsOutCardinalIcon,
    PianoKeysIcon,
    SlidersHorizontalIcon,
    PaletteIcon,
    CaretRightIcon,
    CaretLeftIcon,
    DotsThreeVerticalIcon,
    WarningIcon,
  } from 'phosphor-svelte';
  import type { RackModule } from '../../lib/engine/types';
  import type { PatchGroup } from '../../lib/engine/drawerGroups';
  import type { ModuleStyleUpdate } from '../../lib/engine/EngineBridge';
  import {
    MODULE_ICONS,
    MODULE_STYLE_VARIANTS,
    MODULE_TEXTURES,
    type ModuleIcon,
    type ModuleStyleVariant,
    type ModuleTexture,
  } from '../../lib/engine/moduleAppearance';
  import { MODULE_GLYPHS } from '../../lib/components/icons/moduleGlyphs';
  import ModuleGlyph from '../../lib/components/icons/ModuleGlyph.svelte';
  import { describeTrigger } from '../../lib/engine/midi';
  import Knob from '../knob/Knob.svelte';
  import Switch from '../knob/Switch.svelte';
  import Meter from '../knob/Meter.svelte';
  import Select from '../../lib/components/Select.svelte';
  import IconButton from '../../lib/components/IconButton.svelte';
  import Popover from '../../lib/components/Popover.svelte';
  import InlineRenameInput from '../../lib/components/InlineRenameInput.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';
  import PatchBar from './PatchBar.svelte';
  import Tone3000Logo from '../tone3000/Tone3000Logo.svelte';
  import { cellOf, knobSignature, normalizePositions, ROWS } from '../../lib/engine/knobLayout';

  interface Props {
    module: RackModule;
    /** Global edit mode, toggled from the top bar. */
    editing: boolean;
    onBypass: (b: boolean) => void;
    /** The engine is still applying a bypass toggle; the power button spins
        and stays revealed until the new state comes back. */
    bypassPending?: boolean;
    /** This card is the one being dragged to a new rack position: dim it so
        the drag image reads as the module "in flight". */
    moduleDragging?: boolean;
    /** Lift the module drag up into the rack — the gesture spans cards, so
        the rack owns the in-flight state and the drop targets. */
    onModuleDragStart?: () => void;
    onModuleDragEnd?: () => void;
    /** This card's control editor is switched on: the per-knob affordances and
        the empty "+" cells are showing. Toggled from the module's own menu, and
        owned by the rack so only one card is ever unfolded. */
    knobEditing?: boolean;
    /** Turn this card's control editor on (or off, if it is the one that is
        on). Absent on a card that cannot offer it. */
    onToggleKnobEditing?: () => void;
    onParam: (paramIndex: number, value: number) => void;
    /** Add a parameter control into the selected grid cell. */
    onAddKnob: (paramIndex: number, pos: number) => void;
    onRemoveKnob: (knobId: string) => void;
    onRemapKnob: (knobId: string, paramIndex: number) => void;
    onMoveKnob: (knobId: string, pos: number) => void;
    onRenameKnob: (knobId: string, label: string) => void;
    onSetKnobMeter: (knobId: string, isMeter: boolean) => void;
    onSetKnobMeterBipolar: (knobId: string, bipolar: boolean) => void;
    onRenameModule: (name: string) => void;
    /** Apply a partial update to the card's look — colour, style variant,
        icon, texture. See `ModuleStyleUpdate` for the undefined/null rules. */
    onSetStyle: (style: ModuleStyleUpdate) => void;
    /** The knobId whose MIDI learn is armed on this module, or null. One learn
        is armed rack-wide; the rack owns that state. */
    knobMidiLearningId?: string | null;
    /** True while this module's bypass-trigger learn is armed. */
    moduleMidiLearning?: boolean;
    /** Arm (or click-again to disarm) the MIDI learn for a knob. Clear-first:
        the button clears instead when the knob is already bound. */
    onKnobMidiLearnToggle: (knobId: string, isBoolean: boolean) => void;
    onKnobMidiClear: (knobId: string) => void;
    onModuleMidiLearnToggle: () => void;
    onModuleMidiClear: () => void;
    /** Saved patches available for this module's plugin, grouped and ordered
        exactly as the drawer files them — see PatchBar. */
    patchSections: PatchGroup[];
    /** Save this module's current knob layout and the plugin's tone as a new
        reusable patch. Resolves with the new patch's id, or null if it could
        not be saved. */
    onSavePatch: (name: string) => Promise<string | null>;
    /** Recapture this module's knob layout and tone into an existing patch. */
    onUpdatePatch: (patchId: string) => Promise<void>;
    /** Replace the module's knobs with a saved patch's mapping, and restore
        the plugin tone it was saved with. */
    onLoadPatch: (patchId: string) => void;
    /** Try a patch on this card while the pointer is on its row in the patch
        menu: its knob mapping and look are applied, the plugin's tone is not,
        so the preview shows without sounding and undoes for free. */
    onPreviewPatch: (patchId: string) => void;
    /** End that preview, putting the card back as it was. */
    onCancelPatchPreview: () => void;
    onRenamePatch: (patchId: string, name: string) => void;
    onDeletePatch: (patchId: string) => void;
    /** Present only on modules hosting Neural Amp Modeler — the one plugin a
        TONE3000 tone loads into. Absent leaves the dock as it was, so no other
        module grows a TONE3000 button. */
    onBrowseTone3000?: () => void;
    /** Keep this module's knob layout as the TONE3000 template — see PatchBar,
        which is where the row lives. NAM modules only, like onBrowseTone3000. */
    onSetTone3000Template?: () => void;
    onOpen: () => void;
    /** Remove this module from the rack — the menu's counterpart to dragging
        the card onto the Remove pill, for when the pointer is already here. */
    onRemove: () => void;
    /** Open this tone's page on TONE3000. Present only on a module playing a
        TONE3000 tone, and absent if the tone carries no URL — an older patch
        may not. */
    onOpenTone?: () => void;
    /** Switch to another of the tone's captures. */
    onSelectTone3000Model?: (modelId: number) => void;
  }

  let {
    module,
    editing,
    onBypass,
    bypassPending = false,
    moduleDragging = false,
    onModuleDragStart,
    onModuleDragEnd,
    knobEditing = false,
    onToggleKnobEditing,
    onParam,
    onAddKnob,
    onRemoveKnob,
    onRemapKnob,
    onMoveKnob,
    onRenameKnob,
    onSetKnobMeter,
    onSetKnobMeterBipolar,
    onRenameModule,
    onSetStyle,
    knobMidiLearningId = null,
    moduleMidiLearning = false,
    onKnobMidiLearnToggle,
    onKnobMidiClear,
    onModuleMidiLearnToggle,
    onModuleMidiClear,
    patchSections,
    onSavePatch,
    onUpdatePatch,
    onLoadPatch,
    onPreviewPatch,
    onCancelPatchPreview,
    onRenamePatch,
    onDeletePatch,
    onBrowseTone3000,
    onSetTone3000Template,
    onOpen,
    onRemove,
    onOpenTone,
    onSelectTone3000Model,
  }: Props = $props();

  // A small, deliberately distinguishable palette of accent colours. Kept short
  // so choices stay visually distinct; `null` clears the tint. These values are
  // persisted per module, so they are stored as-is and tuned for the dark panel;
  // the light theme clamps their lightness at render time (see .module-tinted).
  const PALETTE: Array<{ name: string; value: string }> = [
    { name: 'Red', value: '#ef4444' },
    { name: 'Orange', value: '#f97316' },
    { name: 'Amber', value: '#f59e0b' },
    { name: 'Green', value: '#22c55e' },
    { name: 'Teal', value: '#14b8a6' },
    { name: 'Blue', value: '#3b82f6' },
    { name: 'Violet', value: '#8b5cf6' },
    { name: 'Pink', value: '#ec4899' },
  ];

  // True while the title is being edited inline (edit mode + name clicked).
  let renamingName = $state(false);
  // The title no longer says which plugin this is. Renaming to the plugin's own
  // name counts as unrenamed — the title already carries it.
  const renamed = $derived(!!module.displayName && module.displayName !== module.name);

  /** What the title bar is showing, and whether it has been cut short. The
      title now runs the width of the card (see `.module-title`), so how much
      fits depends on the knob grid below it rather than on any character
      count — the rendered box is the only honest test, and a resize observer
      is what keeps the answer true as the card grows and folds. Used solely to
      decide whether the header owes a tooltip carrying the whole name. */
  const shownTitle = $derived(module.displayName ?? module.name);
  let titleTruncated = $state(false);
  function measureTitle(el: HTMLElement, _text: string) {
    const update = () => (titleTruncated = el.scrollWidth > el.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }
  /** True while the module's overflow menu is open. One menu now holds every
      module-level edit affordance that is not the card itself — the MIDI
      on/off learn and the four style dimensions — hung off a kebab button in
      the bottom dock, beside the patches, which is where the rest of what the
      module can do already lives. It sat in the header first, and before that
      it was two separate controls in two places (a header button and a swatch
      in the dock); each move has been the same one, towards every module-level
      action being in one row and the header being a title and a switch. Also
      opened by right-clicking the card — see `openMenuFromCard`. */
  let menuOpen = $state(false);
  /** Which page of the options menu is showing. The look pickers (colour,
      style, icon, texture) are a page of their own reached from the Appearance
      row and left by a back button, rather than a fold that pushed the panel
      past its own height — see the markup. Reset to the list when the menu
      closes: a page is somewhere you navigated to, and the kebab should always
      open on the same thing. */
  let menuPage = $state<'main' | 'appearance'>('main');
  // The kebab itself, so the card's right-click can open the menu through it.
  let moreBtnEl = $state<HTMLButtonElement>();
  // Option currently hovered/focused in that popover, one slot per dimension.
  // The card wears it while it's set, so a choice can be judged on the real
  // module before committing; `''` previews the cleared state, hence null
  // (not '') as the "no preview".
  let previewColor = $state<string | null>(null);
  let previewVariant = $state<ModuleStyleVariant | '' | null>(null);
  let previewIcon = $state<ModuleIcon | '' | null>(null);
  let previewTexture = $state<ModuleTexture | '' | null>(null);
  // What the card actually renders: the preview wins over the saved look.
  const shownColor = $derived(previewColor ?? module.color);
  const shownVariant = $derived((previewVariant ?? module.styleVariant ?? 'subtle') || 'subtle');
  const shownIcon = $derived(previewIcon === null ? module.icon : previewIcon || undefined);
  const shownTexture = $derived(
    previewTexture === null ? module.texture : previewTexture || undefined,
  );
  // The saved (not previewed) selection each picker section highlights.
  const currentVariant = $derived(module.styleVariant ?? 'subtle');
  // A colour picked freely rather than from the palette lights the custom well.
  const customColorActive = $derived(
    !!module.color && !PALETTE.some((c) => c.value === module.color),
  );
  const VARIANT_LABELS: Record<ModuleStyleVariant, string> = {
    subtle: 'Subtle',
    bold: 'Bold',
    outline: 'Outline',
  };
  const TEXTURE_LABELS: Record<ModuleTexture, string> = {
    metal: 'Metal',
    tolex: 'Tolex',
    carbon: 'Carbon',
  };
  // True while the patch menu is open. Both keep the docks revealed after the
  // pointer leaves the card, so an open menu never floats over hidden controls.
  let patchMenuOpen = $state(false);
  // Knob drag state (see the drag handlers below): the knob being dragged,
  // which drives the lifted visual and reveals the drop targets, and the cell
  // currently under it. Declared here because `expanded` reads them.
  let draggingKnobId = $state<string | null>(null);
  let dragOverPos = $state<number | null>(null);

  // Leaving edit mode also cancels any inline rename / open palette.
  $effect(() => {
    if (!editing) {
      renamingName = false;
      menuOpen = false;
    }
  });

  // Closing has to drop the previews with it — the option unmounts under the
  // pointer, so its own pointerleave never arrives. The panel can close
  // from inside Popover (Escape, outside click), so the previews are tied to
  // the open state rather than to any one close path. The page goes back with
  // them: the kebab always opens on the list.
  $effect(() => {
    if (!menuOpen) {
      previewColor = null;
      previewVariant = null;
      previewIcon = null;
      previewTexture = null;
      menuPage = 'main';
    }
  });

  // Picks leave the panel open: the look has four dimensions, and setting one
  // is usually the start of setting another. Escape / outside click closes.
  function pickColor(color: string) {
    onSetStyle({ color: color || null });
  }
  function pickVariant(variant: ModuleStyleVariant) {
    // `subtle` is the absent default and is never persisted, so old files and
    // an explicitly-picked Subtle stay the same document.
    onSetStyle({ styleVariant: variant === 'subtle' ? null : variant });
  }
  function pickIcon(icon: ModuleIcon | null) {
    onSetStyle({ icon });
  }
  function pickTexture(texture: ModuleTexture | null) {
    onSetStyle({ texture });
  }
  /** Right-click anywhere on the card opens the same options menu — the gesture
      every rack host already answers, and what makes the kebab's placement stop
      being load-bearing: the button is the discoverable path, this is the fast
      one. Deliberately anchored to the kebab rather than to the pointer, so the
      menu is always in the same place however it was asked for. Text fields keep
      their native menu (a rename wants paste); the popover itself is portalled
      to <body>, so it is never under this handler to begin with.

      It clicks the kebab rather than assigning `menuOpen`: Popover snapshots the
      trigger's rectangle inside its own open path, so a panel opened by setting
      the flag is placed wherever the last one was — at 0,0 the first time. */
  function openMenuFromCard(e: MouseEvent) {
    if (!editing) return;
    if ((e.target as HTMLElement | null)?.closest('input, textarea')) return;
    e.preventDefault();
    if (!menuOpen) moreBtnEl?.click();
  }
  /** Clear-first, like every learn control. Arming closes the menu: the next
      thing to happen is a footswitch press, and the panel would otherwise sit
      over the card whose "Listening" state is the only feedback there is. */
  function toggleModuleMidi() {
    if (module.midi) {
      onModuleMidiClear();
    } else {
      onModuleMidiLearnToggle();
      menuOpen = false;
    }
  }
  // Options for the filterable Select dropdowns.
  const paramOptions = $derived(
    module.availableParams.map((ap) => ({
      value: String(ap.index),
      label: ap.name,
    })),
  );

  // Signature of the current knob layout, so PatchBar can tell whether the
  // module still matches the patch it was loaded from.
  const currentSignature = $derived(knobSignature(module.params));

  // Knob layout: a sparse 2-row grid that grows rightward. Each knob owns a
  // fixed cell (see knobLayout.ts) so adding/moving one never disturbs the
  // others; new knobs fill top-then-bottom of each column in turn.
  const positioned = $derived(normalizePositions(module.params));

  /** The tone's artwork, and the one flag that turns it off: it is a remote
      image on TONE3000's CDN, so it can simply not arrive — offline, or a tone
      taken down — and the card goes back to being an ordinary card. */
  let artworkFailed = $state(false);
  const artwork = $derived(artworkFailed ? undefined : module.tone3000?.imageUrl);

  /** The attribution line, written once and worn by both ways into the tone —
      the mark in the header and the photograph in the body. Only the picture
      shows it: two links to the same page do not need two captions, and the
      picture is the bigger, more obvious target of the pair. */
  const toneTip = $derived(
    module.tone3000
      ? [
          module.tone3000.title,
          module.tone3000.creator.username && `by @${module.tone3000.creator.username}`,
          module.tone3000.license,
        ]
          .filter(Boolean)
          .join(' · ') + ' — open on TONE3000'
      : null,
  );

  /** The controls column (capture selector + knob grid), measured, and the
      square the artwork is drawn at.

      Measured rather than sized in CSS, and not for want of trying: a flex
      item's *width* is resolved before the cross-axis stretch that would give
      it a height, so `align-self: stretch; aspect-ratio: 1` computes a width of
      zero — the frame's picture is positioned out of flow, so there is no
      content to size it from either. The artwork was there all along, nought
      pixels wide.

      Observing the column rather than the body avoids the obvious feedback
      loop: the artwork is a sibling of what it measures, never a part of it. */
  let controlsHeight = $state(0);

  /** Attached to the controls column below — the attachment is handed the
      element, so nothing has to be mirrored into a `bind:this`. */
  function measureControls(element: HTMLElement) {
    const observer = new ResizeObserver(() => (controlsHeight = element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }

  /** One square, the same on every TONE3000 card.

      Filling the measured height looked right on one card and wrong across a
      rack: the column is taller when the tone has several captures (the
      selector) and taller again when a knob label wraps ("THRESHO LD"), so
      neighbouring modules ended up with visibly different pictures. These are
      the same kind of object and should read as a row of them.

      152px is the two-row knob block a TONE3000 module normally has — the
      template mapping's six controls. The measurement is kept only as a
      ceiling, so a card with less room (a slimmer template, a re-mapped
      module) crops rather than overflowing. */
  const TONE_ART_PX = 152;
  const artSize = $derived(controlsHeight > 0 ? Math.min(TONE_ART_PX, controlsHeight) : 0);

  /** The tone's other captures, when it has more than one. */
  const variants = $derived(module.tone3000?.models ?? []);

  /** Where the loaded capture sits in that list — what the step buttons
      move from. */
  const variantIndex = $derived(variants.findIndex((v) => v.modelId === module.tone3000?.modelId));

  /** Step to the neighbouring capture. Clamped, not wrapped: auditioning
      captures in order is the gesture, and a list that jumps from its last
      entry back to its first mid-sweep is easy to overshoot without noticing —
      the disabled arrow is what says "you have heard them all". */
  function stepVariant(delta: number) {
    if (variantIndex < 0) return;
    const next = variantIndex + delta;
    if (next < 0 || next >= variants.length) return;
    onSelectTone3000Model?.(variants[next].modelId);
  }

  /** Whether this card is allowed to offer the control editor at all. A
      missing plugin has no parameters to map, so the "+" cells and the pickers
      would all be empty. A TONE3000 module is *not* excluded: its mapping
      arrives with the tone (from the template in Settings), but it is the same
      plugin as any other module's and the user may re-map it — the tone's own
      identity (capture, artwork, attribution) rides on the provenance, not on
      the knob layout. Picking the tone again restores the template. */
  const canEditKnobs = $derived(editing && !module.missing);

  /** Edit mode as the knob grid sees it — now an explicit per-module switch
      thrown from the module's own menu, not something the pointer falls into.
      Hovering a card used to unfold it, which meant the mapping controls
      appeared under a pointer merely passing through and the rack reflowed as
      it went; a mode you are in on purpose is one you can also stay out of.

      Module-level editing — move, rename, colour, bypass, patches — is
      untouched by either this or sealing: those are facts about the card, not
      about the controls inside it. */
  const editingKnobs = $derived(canEditKnobs && knobEditing);
  const occupied = $derived(new Set(positioned.map((p) => p.pos!)));

  // The edit affordances that cost layout — the empty "+" cells and the spare
  // drag-out column — unfold exactly when the control editor is on. The rack
  // keeps that to one card at a time, so it stays compact instead of every
  // module ballooning at once; unlike the hover latch this replaced, the card
  // that is unfolded is the one the user asked for, and it stays that way until
  // they say otherwise.
  const expanded = $derived(editingKnobs);

  // Columns needed to show every knob, plus one spare column while unfolded so
  // a knob can be dragged out to the right to grow the grid.
  const cols = $derived.by(() => {
    const maxPos = positioned.length ? Math.max(...positioned.map((p) => p.pos!)) : -1;
    const usedCols = Math.floor(maxPos / ROWS) + 1;
    return Math.max(usedCols, 1) + (expanded ? 1 : 0);
  });
  // Empty drop targets (unfolded only): every grid cell not holding a knob.
  const emptyCells = $derived.by(() => {
    if (!expanded) return [];
    const free: number[] = [];
    for (let pos = 0; pos < cols * ROWS; pos++) if (!occupied.has(pos)) free.push(pos);
    return free;
  });

  // CSS grid placement for a column-major cell index.
  function cellStyle(pos: number): string {
    const { col, row } = cellOf(pos);
    return `grid-column:${col + 1};grid-row:${row + 1}`;
  }

  function commitName(value: string) {
    onRenameModule(value);
    renamingName = false;
  }

  // --- Drag knobs to grid cells (edit mode only) ---------------------------
  // `dragOverPos` is tracked explicitly rather than with :hover, which the
  // browser does not update while a drag is in flight.
  //
  // The drag handle is the drag source — not the tile — so every control keeps
  // its own gesture (turn a knob, flip a switch) in edit mode. The tile is only
  // borrowed as the drag image, so what follows the cursor is the whole control.
  function onKnobDragStart(e: DragEvent, knobId: string) {
    draggingKnobId = knobId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox requires data to be set for a drag to start.
      e.dataTransfer.setData('text/plain', knobId);
      const tile = (e.currentTarget as HTMLElement).closest<HTMLElement>('.knob-reorderable');
      if (tile) e.dataTransfer.setDragImage(tile, tile.offsetWidth / 2, tile.offsetHeight / 2);
    }
  }

  // Drop onto a cell: the engine swaps with any knob already there and leaves
  // every other knob in place. The keyed {#each} + animate:flip does the rest.
  function onCellDrop(e: DragEvent, pos: number) {
    e.preventDefault();
    if (draggingKnobId) onMoveKnob(draggingKnobId, pos);
    onKnobDragEnd();
  }

  function onKnobDragEnd() {
    draggingKnobId = null;
    dragOverPos = null;
  }

  // --- Drag the whole module to another rack position (edit mode only) -----
  // Same handle pattern as the knobs, but the drop targets live in the rack
  // (every insert gap), so the in-flight state is lifted up via the callbacks.
  function startModuleDrag(e: DragEvent) {
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox requires data to be set for a drag to start.
      e.dataTransfer.setData('text/plain', module.id);
      // The whole card follows the cursor, not the tiny handle.
      if (panelEl)
        e.dataTransfer.setDragImage(panelEl, panelEl.offsetWidth / 2, panelEl.offsetHeight / 2);
    }
    onModuleDragStart?.();
  }

  function endModuleDrag() {
    onModuleDragEnd?.();
  }

  // --- Smooth grow/shrink when edit mode toggles --------------------------
  // The card is content-sized (w-fit / auto height), so CSS can't transition it
  // between intrinsic sizes reliably. Instead we FLIP: remember the last size,
  // and after the DOM reflows to the new one, animate width/height from old to
  // new with the Web Animations API (siblings reflow along with it).
  let panelEl = $state<HTMLElement>();
  let clipEl = $state<HTMLElement>();
  let prevSize: { w: number; h: number } | null = null;
  let resizeAnim: Animation | null = null;

  /** Attached to the panel. The card also resizes for reasons the tween
      effect never sees — the tone art arrives a frame after mount (`artSize`
      is measured), a knob label wraps, a capture selector mounts. `prevSize`
      has to follow those, or the next toggle the effect *does* see animates
      from a size the card left long ago: the first rename on a TONE3000 card
      snapped it back to its pre-art width and grew it from there. The
      observer keeps `prevSize` current whenever no tween is in flight; the
      effect below still reads it before the observer can see the toggle's
      own reflow, so an intended tween keeps its true "from" size. */
  function trackRestingSize(el: HTMLElement) {
    const observer = new ResizeObserver(() => {
      if (resizeAnim) return;
      prevSize = { w: el.offsetWidth, h: el.offsetHeight };
    });
    observer.observe(el);
    return () => observer.disconnect();
  }

  $effect(() => {
    editing; // re-run whenever edit mode toggles…
    expanded; // …and whenever the hovered card folds or unfolds
    renamingName; // …and when the rename input's minimum width grows the card
    if (!panelEl) return;
    const el = panelEl;
    // A tween still in flight overrides width/height, so it has to be cancelled
    // before measuring — otherwise we'd read the animated size rather than the
    // new natural one, and the next tween would run between the wrong bounds.
    resizeAnim?.cancel();
    resizeAnim = null;
    el.classList.remove('module-resizing');
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (prevSize && (prevSize.w !== w || prevSize.h !== h)) {
      // The size the content is pinned to for the duration: clientWidth/Height
      // is the panel's inner box, i.e. exactly what .module-clip occupies.
      // Written on the clip, not the panel — the panel's style attribute is
      // Svelte's (the module tint), and a re-render would drop these.
      clipEl?.style.setProperty('--clip-w', `${el.clientWidth}px`);
      clipEl?.style.setProperty('--clip-h', `${el.clientHeight}px`);
      const anim = el.animate(
        [
          { width: `${prevSize.w}px`, height: `${prevSize.h}px` },
          { width: `${w}px`, height: `${h}px` },
        ],
        { duration: 300, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)' },
      );
      resizeAnim = anim;
      // The knob grid inside jumps to its final layout in a single frame. Hold
      // it there (see .module-resizing) and clip it to the card's animating
      // edge, so the growth uncovers the new cells and every existing knob
      // stays exactly where it already was. Toggled imperatively, not via
      // class:, so the clip is in place for the tween's very first frame.
      el.classList.add('module-resizing');
      const done = () => {
        if (resizeAnim !== anim) return; // superseded by a newer tween
        resizeAnim = null;
        el.classList.remove('module-resizing');
      };
      anim.finished.then(done, done);
    }
    prevSize = { w, h };
    // Unmounting mid-tween would otherwise leave an Animation running against a
    // detached element. A re-run cancels at the top of the body anyway, so this
    // is really about destroy; cancelling twice is a no-op.
    return () => {
      resizeAnim?.cancel();
      resizeAnim = null;
    };
  });
</script>

<!-- The "+" trigger content for an empty knob slot (fills the whole cell). -->
{#snippet plusPlaceholder()}
  <span class="knob-add-plus" aria-hidden="true">+</span>
{/snippet}

<!-- The tone's photograph itself. Shared by the frame's two forms — a button
     when there is a page to open, a plain span otherwise — so the picture and
     its failure handling are written once. -->
{#snippet artworkImage()}
  <img
    src={artwork}
    alt=""
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    draggable="false"
    onerror={() => (artworkFailed = true)}
  />
{/snippet}

<div
  bind:this={panelEl}
  {@attach trackRestingSize}
  class="module-panel flex w-fit shrink-0 flex-col overflow-hidden rounded-2xl border border-ink/20 bg-panel backdrop-blur-2xl"
  class:module-editing={editing}
  class:module-expanded={expanded}
  class:module-drag-source={moduleDragging}
  class:module-menu-open={menuOpen || patchMenuOpen}
  class:module-learning={moduleMidiLearning}
  oncontextmenu={openMenuFromCard}
  role="group"
  aria-label={module.displayName ?? module.name}
  class:module-tinted={shownColor}
  class:variant-bold={shownVariant === 'bold'}
  class:variant-outline={shownVariant === 'outline'}
  class:texture-metal={shownTexture === 'metal'}
  class:texture-tolex={shownTexture === 'tolex'}
  class:texture-carbon={shownTexture === 'carbon'}
  class:module-bypassed={module.bypassed}
  class:module-missing={module.missing}
  style={shownColor ? `--module-color:${shownColor}` : undefined}
>
  <!-- Edit-mode controls dock outside the card: the two labelled actions above,
       the arrange toolbar below. Both float on absolute layers, so the card
       itself keeps its play-mode footprint and the knob grid stays the whole
       visual weight of the panel. -->
  <!-- Two wrappers, both no-ops until the card tweens between sizes: the outer
       one clips to the card's animating edge (so the docks, which live outside
       it, are never clipped), the inner one holds the header and knob grid at
       the size the card is animating *to*. -->
  <div bind:this={clipEl} class="module-clip">
    <div class="module-clip-inner">
      <!-- In edit mode the header doubles as the move handle, like a window's
           title bar: drag it to any insert gap — or onto the Remove pill that
           floats in at the top mid-drag, which is how a module is deleted.
           The grip line at its top edge is the cue. A click (no movement)
           still reaches the title's rename, so the two gestures share the
           bar. Never draggable while renaming: selecting text in the input
           is the same gesture as a drag. -->
      <div
        class="module-header relative flex items-center justify-between gap-2 px-3 py-1.5"
        class:module-header-editing={editing}
        class:module-header-grab={editing && !renamingName}
        draggable={editing && !renamingName}
        ondragstart={editing ? startModuleDrag : undefined}
        ondragend={editing ? endModuleDrag : undefined}
        role="group"
        aria-label="{module.displayName ?? module.name} header{editing
          ? ' — drag to move the module'
          : ''}"
      >
        {#if editing}
          <span class="grab-line" aria-hidden="true"></span>
        {/if}
        {#if module.missing}
          <!-- The plugin behind this card could not be loaded; the module is an
           inert placeholder and the chain treats it as switched off. The badge
           is the state's one always-visible marker, so it leads the header. -->
          <span
            class="missing-badge shrink-0"
            {@attach tooltip(
              `${module.name} is not installed — audio passes through. Reinstall the plugin and load the rig again to bring this module back.`,
              { placement: 'top', positionFrom: '.module-panel' },
            )}
          >
            <WarningIcon size={13} weight="fill" aria-hidden="true" />
            missing
          </span>
        {/if}
        {#if module.tone3000}
          <!-- The T3K mark leads the header, which is where a mark belongs: it
               says whose tone this is before the title says which one. It is
               also the link — clicking opens the tone's own page on TONE3000,
               which is the attribution their terms ask for and the fastest way
               back to the notes, comments and other captures of the same amp.

               Small on purpose (11px): the card's subject is the amp in the
               picture, not the service it came from — which is also why the
               attribution tooltip hangs off the picture and not off this mark.
               The mark stays a link so the way out is still there on a card
               whose artwork never arrived. -->
          <button
            type="button"
            class="tone-mark shrink-0"
            onclick={onOpenTone}
            disabled={!onOpenTone}
            aria-label="View “{module.tone3000.title}” on TONE3000"
          >
            <Tone3000Logo variant="mark" height={11} />
          </button>
        {/if}
        {#if shownIcon}
          <!-- Decorative glyph beside the title; coloured by the accent in
               scope, so a tinted card tints its icon with it. -->
          <!-- Pulls the title back against the header's gap: the glyph and the
               title read as one label, not two items in the control row. -->
          <span class="module-glyph -mr-1 shrink-0" aria-hidden="true">
            <ModuleGlyph icon={shownIcon} size={20} />
          </span>
        {/if}
        {#if editing && renamingName}
          <!-- `min-w-[22ch]` — the same cap the title's ghost asks for — is what
           keeps renaming possible on a narrow card: a one-column (or knobless)
           card squeezed the growable input to a few characters. The card is
           w-fit, so the header widens it for the edit and the FLIP tween below
           carries it there and back. `leading-normal` because the box must be
           the title's box: the title inherits the page's 1.5 line-height while
           an input's own default is smaller, and the mismatch nudged the whole
           card shorter for the duration of the rename. -->
          <InlineRenameInput
            value={module.displayName ?? module.name}
            placeholder={module.name}
            ariaLabel="Rename module"
            class="text-input w-0 min-w-[22ch] grow truncate px-1.5 py-0.5 text-sm leading-normal font-semibold tracking-[0.2px] text-ink"
            onCommit={commitName}
            onCancel={() => (renamingName = false)}
          />
        {:else if editing}
          <!-- Sized exactly as the play-mode title: the name is part of what makes
           a folded card the width it is, so truncating it once the card unfolds
           would shrink the title just as the card grows. -->
          <button class="module-title module-title-editable" onclick={() => (renamingName = true)}>
            <span class="module-title-ghost" aria-hidden="true">{shownTitle}</span>
            <span class="module-title-text">{shownTitle}</span>
          </button>
        {:else}
          <!-- The title shows whatever the user named the module; the tooltip
           carries what the card cannot — the hosted plugin's own name once a
           rename has hidden it, or the whole title once the width cap has cut
           it short (a TONE3000 capture's name routinely runs past it). Placed
           off the card rather than the title, so it sits above the module with
           its arrow on the border instead of hanging over the knob grid. -->
          <span
            class="module-title"
            {@attach tooltip(titleTruncated ? shownTitle : renamed ? module.name : null, {
              placement: 'top',
              positionFrom: '.module-panel',
            })}
          >
            <span class="module-title-ghost" aria-hidden="true">{shownTitle}</span>
            <span
              class="module-title-text"
              {@attach (el: HTMLElement) => measureTitle(el, shownTitle)}>{shownTitle}</span
            >
          </span>
        {/if}
        <!-- The header's control cluster: the power switch, and nothing else.
             It was a pair — the switch and the options kebab — and two floating
             circles covered the end of the title they overlap, which on a folded
             card is most of it. The kebab moved to the bottom dock (see there);
             what is left is the one control that has to be reachable in play
             mode, so the box stays rather than collapsing into the label. -->
        <div class="header-actions shrink-0">
          <!-- Power (bypass): pinned to the right and revealed only on hover. In
           play mode it floats over the end of the title where the two overlap. -->
          <!-- No tooltip: a power symbol on a card that is visibly on or off
               needs no caption, and this one sat over the card above it. The
               aria-label below still names the action. -->
          <label class="bypass-wrap" class:bypass-pending={bypassPending}>
            <input
              type="checkbox"
              checked={!module.bypassed}
              disabled={bypassPending}
              onchange={(e) => onBypass(!e.currentTarget.checked)}
              aria-busy={bypassPending}
              aria-label={module.bypassed ? 'Turn on' : 'Turn off'}
            />
            <span class="bypass-icon">
              {#if bypassPending}
                <CircleNotchIcon class="animate-spin" size={14} weight="bold" aria-hidden="true" />
              {:else}
                <PowerIcon size={14} weight="regular" aria-hidden="true" />
              {/if}
            </span>
          </label>
        </div>
      </div>

      {#if module.params.length > 0 || expanded}
        <div class="module-body flex flex-1 items-start gap-3 px-3 py-3">
          {#if artwork}
            <!-- The tone's own photograph, on the card rather than in the hover
                 dock: it is what the module *is*, and a picture of the amp is
                 read faster than any title. Square and small — big enough to
                 recognise a tweed from a plexi at a glance, not big enough to
                 compete with the knobs, which are what the card is for.

                 Left of both the capture selector and the grid, so it reads as
                 the module's identity rather than as decoration attached to one
                 control. It takes the body's full height and squares off that
                 measurement (see `.tone-art`), so it grows with the knob rows
                 rather than being a fixed stamp that looks lost beside two of
                 them.

                 It is the second way to the tone's own page — the same link the
                 header's mark carries, on the thing someone is actually looking
                 at — and it is where the attribution tooltip lives, placed left
                 so the caption sits clear of the card rather than over the knobs
                 it would otherwise cover. A button only when there is somewhere
                 to go; a tone with no url stays an inert picture. -->
            {#if onOpenTone}
              <button
                type="button"
                class="tone-art"
                onclick={onOpenTone}
                aria-label="View “{module.tone3000?.title}” on TONE3000"
                style:width="{artSize}px"
                style:height="{artSize}px"
                style:visibility={artSize > 0 ? 'visible' : 'hidden'}
                {@attach tooltip(toneTip, { placement: 'left', positionFrom: '.module-panel' })}
              >
                {@render artworkImage()}
              </button>
            {:else}
              <span
                class="tone-art"
                style:width="{artSize}px"
                style:height="{artSize}px"
                style:visibility={artSize > 0 ? 'visible' : 'hidden'}
                {@attach tooltip(toneTip, { placement: 'left', positionFrom: '.module-panel' })}
              >
                {@render artworkImage()}
              </span>
            {/if}
          {/if}
          <div class="flex min-w-0 flex-1 flex-col" {@attach measureControls}>
            {#if variants.length > 1}
              <!-- A tone is usually several captures of one amp — two channels at
                 three gain settings, say — and choosing between them is playing,
                 not editing: it belongs on the card, one click away, not behind
                 a menu. Sits above the knobs because it changes what they are
                 shaping. The names are TONE3000's own ("TB Brl 3"), which is
                 what the person who made the capture called it. -->
              <!-- `w-0 min-w-full`: the row takes the width the knob grid decided
                 and never asks for more. A capture name is long — that is what
                 they are like — and a card sized to one would not line up with
                 anything else in the rack; the trigger truncates instead. -->
              <!-- No visible label: the selector sits alone above the knobs on a
                 card that is already a TONE3000 tone, and the names in it read
                 as captures on sight. The name it needs is on the control
                 itself, for anything not looking at the card. -->
              <!-- The arrows audition neighbouring captures without opening
                 the menu. Both sit to the right of the trigger, a paired
                 stepper. Deliberately no wheel gesture: the wheel is how the
                 rack pans, and a row that hijacked it swapped captures while
                 the player was merely scrolling past. -->
              <!-- Choosing the capture is edit-mode work: which capture a module
                 plays is part of what the module *is*, settled while building
                 the rig, and a stepper an elbow can nudge mid-song is the last
                 thing a performing rack wants. So in perform mode the arrows go
                 and the select is inert — still printing the capture's name,
                 which is the half worth keeping on stage. -->
              <div class="mb-2 flex w-0 min-w-full items-center gap-1">
                <Select
                  class="min-w-0 flex-1"
                  size="sm"
                  variant="plain"
                  options={variants.map((v) => ({ value: String(v.modelId), label: v.name }))}
                  value={String(module.tone3000?.modelId ?? '')}
                  onSelect={(v) => onSelectTone3000Model?.(Number(v))}
                  disabled={!editing}
                  aria-label="Capture"
                />
                {#if editing}
                  <IconButton
                    label="Previous capture"
                    disabled={variantIndex <= 0}
                    onclick={() => stepVariant(-1)}
                  >
                    <CaretLeftIcon size={13} weight="bold" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label="Next capture"
                    disabled={variantIndex < 0 || variantIndex >= variants.length - 1}
                    onclick={() => stepVariant(1)}
                  >
                    <CaretRightIcon size={13} weight="bold" aria-hidden="true" />
                  </IconButton>
                {/if}
              </div>
            {/if}
            <div
              class="grid min-h-20 items-start justify-center gap-x-2 gap-y-2"
              style={`grid-template-columns: repeat(${cols}, 4rem); grid-template-rows: repeat(${ROWS}, auto)`}
            >
              <!-- Empty cells double as drop targets (park a dragged knob here) and as
         "+" placeholders that open the param picker in place to add a knob. -->
              {#each emptyCells as pos (pos)}
                <div
                  class="knob-slot"
                  class:knob-slot-active={!!draggingKnobId}
                  class:knob-slot-over={dragOverPos === pos}
                  style={cellStyle(pos)}
                  role="presentation"
                  ondragenter={() => (dragOverPos = pos)}
                  ondragleave={() => dragOverPos === pos && (dragOverPos = null)}
                  ondragover={(e) => e.preventDefault()}
                  ondrop={(e) => onCellDrop(e, pos)}
                >
                  {#if !draggingKnobId}
                    <Select
                      class="knob-add"
                      options={paramOptions}
                      onSelect={(v) => onAddKnob(Number(v), pos)}
                      filterPlaceholder="Filter parameters…"
                      aria-label="Add a knob"
                      trigger={plusPlaceholder}
                    />
                  {/if}
                </div>
              {/each}

              {#each positioned as p (p.knobId)}
                <div
                  class="group relative flex flex-col items-center gap-2 hover:z-50"
                  class:knob-dragging={draggingKnobId === p.knobId}
                  class:knob-reorderable={editingKnobs}
                  style={cellStyle(p.pos!)}
                  role="presentation"
                  ondragenter={() => (dragOverPos = p.pos!)}
                  ondragleave={() => dragOverPos === p.pos! && (dragOverPos = null)}
                  ondragover={(e) => e.preventDefault()}
                  ondrop={(e) => onCellDrop(e, p.pos!)}
                  animate:flip={{ duration: 260, easing: cubicOut }}
                >
                  {#if p.isMeter}
                    <Meter
                      label={p.label}
                      value={p.value}
                      text={p.text}
                      bipolar={p.meterBipolar}
                      onRename={editingKnobs ? (label) => onRenameKnob(p.knobId, label) : undefined}
                    />
                  {:else if p.isBoolean}
                    <Switch
                      label={p.label}
                      value={p.value}
                      text={p.text}
                      onChange={(v) => onParam(p.paramIndex, v)}
                      onRename={editingKnobs ? (label) => onRenameKnob(p.knobId, label) : undefined}
                    />
                  {:else}
                    <Knob
                      label={p.label}
                      value={p.value}
                      defaultValue={module.availableParams.find((ap) => ap.index === p.paramIndex)
                        ?.defaultValue ?? 0.5}
                      text={p.text}
                      valueStrings={p.valueStrings}
                      onChange={(v) => onParam(p.paramIndex, v)}
                      onRename={editingKnobs ? (label) => onRenameKnob(p.knobId, label) : undefined}
                    />
                  {/if}
                  <!-- Reorder handle: the drag source itself. Unlike the other hover
             controls it stays mounted and visible for the whole gesture, so the
             element the drag started from is never removed mid-drag. -->
                  {#if editingKnobs}
                    <!-- Top-right, matching the module card's own move handle —
               drag-to-move lives top-right everywhere. These per-knob buttons
               hug the tile's edges, so each one's tooltip opens outward on the
               side it sits on rather than over the knob it belongs to. The 7
               offset is the button's own 28px width: it parks them flush outside
               the 4rem cell, where a smaller inset reached back over the knob's
               ring (which the knob pulls out further still for fine adjust). -->
                    <button
                      class="knob-hover-control knob-option-btn knob-drag-btn absolute -top-7 -right-7 z-50"
                      draggable="true"
                      ondragstart={(e) => onKnobDragStart(e, p.knobId)}
                      ondragend={onKnobDragEnd}
                      aria-label="Drag to move {p.label}"
                      {@attach tooltip(`Drag to move ${p.label}`, {
                        placement: 'right',
                      })}
                    >
                      <ArrowsOutCardinalIcon size={15} weight="bold" aria-hidden="true" />
                    </button>
                  {/if}
                  {#if editingKnobs && !draggingKnobId}
                    <!-- The two display options stack down the right edge, under the drag
               handle: the meter toggle, and — only once it is a meter — the
               centred-meter toggle directly below it. -->
                    <button
                      class="knob-hover-control knob-option-btn knob-option-mid absolute -right-7 z-50"
                      class:knob-option-active={p.isMeter}
                      onclick={() => onSetKnobMeter(p.knobId, !p.isMeter)}
                      aria-pressed={p.isMeter}
                      aria-label="Toggle {p.label} meter display"
                      {@attach tooltip('Toggle meter display', {
                        placement: 'right',
                      })}
                    >
                      <GaugeIcon size={15} weight="bold" aria-hidden="true" />
                    </button>
                    {#if p.isMeter}
                      <button
                        class="knob-hover-control knob-option-btn knob-option-below absolute -right-7 z-50"
                        class:knob-option-active={p.meterBipolar}
                        onclick={() => onSetKnobMeterBipolar(p.knobId, !p.meterBipolar)}
                        aria-pressed={p.meterBipolar}
                        aria-label="Toggle {p.label} centre meter"
                        {@attach tooltip('Toggle centred meter', {
                          placement: 'right',
                        })}
                      >
                        <ArrowsInLineVerticalIcon size={15} weight="bold" aria-hidden="true" />
                      </button>
                    {/if}
                    <button
                      class="knob-hover-control knob-remove-btn absolute -top-7 -left-7 z-50"
                      onclick={() => onRemoveKnob(p.knobId)}
                      aria-label="Remove {p.label} control"
                      {@attach tooltip(`Remove ${p.label} control`, {
                        placement: 'left',
                      })}
                    >
                      <TrashIcon size={15} weight="bold" aria-hidden="true" />
                    </button>
                    <!-- MIDI learn, mirroring the meter toggle across the tile: left
               column at widget height. One control, clear-first — Learn when
               unbound, clear when bound. Meters are read-only and get none. -->
                    {#if !p.isMeter}
                      <button
                        class="knob-hover-control knob-option-btn knob-option-mid midi-learn-btn absolute -left-7 z-50"
                        class:knob-option-active={!!p.midi}
                        class:midi-listening={knobMidiLearningId === p.knobId}
                        aria-pressed={knobMidiLearningId === p.knobId}
                        onclick={() =>
                          p.midi
                            ? onKnobMidiClear(p.knobId)
                            : onKnobMidiLearnToggle(p.knobId, !!p.isBoolean)}
                        aria-label={p.midi
                          ? `Clear MIDI control of ${p.label}`
                          : `Learn MIDI control for ${p.label}`}
                        {@attach tooltip(
                          p.midi
                            ? `${describeTrigger(p.midi)} — click to clear`
                            : knobMidiLearningId === p.knobId
                              ? 'Listening — press a switch or move a controller'
                              : 'Learn MIDI control',
                          { placement: 'left' },
                        )}
                      >
                        <PianoKeysIcon size={15} weight="bold" aria-hidden="true" />
                      </button>
                    {/if}
                    <!-- The mapping selector sits below the knob on hover so it adds no
               vertical space to the edit layout. Hidden while a knob is being
               dragged so it doesn't flash under the pointer. -->
                    <div
                      class="knob-hover-control absolute top-full left-1/2 z-50 -translate-x-1/2"
                    >
                      <Select
                        class="knob-param-select w-28"
                        options={paramOptions}
                        value={String(p.paramIndex)}
                        onSelect={(v) => onRemapKnob(p.knobId, Number(v))}
                        filterPlaceholder="Filter parameters…"
                        aria-label="Map {p.label} to parameter"
                      />
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- The module's toolbar, docked below the card in edit mode: its patches and
       its options menu. Everything a module can do that is not the knobs is in
       this one row — the kebab used to sit in the header, which split the same
       class of action across two edges and cost the title the width of a second
       floating circle. Off the card, it also opens over the rack instead of over
       the grid it is a menu for. -->
  {#if editing}
    <div class="module-dock module-dock-bottom">
      <div class="flex shrink-0 items-center gap-1.5">
        <!-- TONE3000's entry point on the card, leftmost and one press away.
             It was a row inside the patch menu, which filed "find a tone" under
             the same control as "load one I already have" and hid it behind an
             open; a tone is chosen from their catalogue, not from this list, so
             it gets a button of its own beside the pill. Compact mark only —
             by the time a module has a dock the drawer has shown the full logo. -->
        {#if onBrowseTone3000}
          <button
            type="button"
            class="module-t3k-btn"
            aria-label="Browse TONE3000"
            onclick={() => onBrowseTone3000?.()}
            {@attach tooltip('Swap this tone for one from TONE3000')}
          >
            <Tone3000Logo variant="mark" height={9} class="shrink-0" />
            <span>Browse</span>
          </button>
        {/if}
        <PatchBar
          bind:open={patchMenuOpen}
          sections={patchSections}
          signature={currentSignature}
          onSave={onSavePatch}
          onUpdate={onUpdatePatch}
          onLoad={onLoadPatch}
          onPreview={onPreviewPatch}
          onCancelPreview={onCancelPatchPreview}
          onRename={onRenamePatch}
          onDelete={onDeletePatch}
          onSetToneTemplate={onSetTone3000Template}
        />
        <!-- Module options, docked beside the patch pill rather than in the
             header. Both are module-level actions and this is the one place
             they now live; the header keeps a title and a power switch at every
             card width, where a third control could only be bought by covering
             the title it sits over. Rightmost, so the kebab is the last thing in
             the row the way it is the last thing in a window's toolbar. -->
        <Popover bind:open={menuOpen} maxHeight={480} gap={6} ariaHasPopup="dialog">
          {#snippet trigger(props)}
            <button
              {...props}
              bind:this={moreBtnEl}
              class="module-more-btn"
              class:module-more-bound={!!module.midi}
              class:midi-listening={moduleMidiLearning}
              aria-label="Module options"
              {@attach tooltip('Module options')}
            >
              <DotsThreeVerticalIcon size={18} weight="bold" aria-hidden="true" />
            </button>
          {/snippet}
          <!-- Hovering any style option applies it to the card live (see the
               preview state), so the choice is judged on the module rather
               than on a 24px chip. Keyboard gets the same from each option's
               focus/blur, so tabbing through previews as the pointer does. -->
          <div class="style-sections">
            <!-- Two pages, one at a time. The list is the menu; Appearance
                 is a place it goes, with a back button in the same corner
                 the kebab was pressed in.

                 It was a fold, and a fold is the wrong shape here: the four
                 pickers are taller than the whole panel, so opening them
                 pushed the menu past its own height and cut Texture off the
                 bottom — and even scrolling, the rows above stayed on
                 screen competing with what the user had just gone looking
                 for. A page shows one thing, at a height it fits in. -->
            {#if menuPage === 'main'}
              <!-- One flat list of rows, no headings: each of these
                   sections held a single line, so an uppercase word above
                   each was labelling something already labelled — three
                   headings to read before reaching four verbs. The icon
                   says which domain a row belongs to and the hint column on
                   the right says what pressing it does, so the menu is read
                   down one column instead of across seven lines. Headings
                   survive only on the Appearance page, where they caption
                   grids of chips that genuinely cannot name themselves. -->
              <div class="menu-rows">
                <!-- The plugin's own editor. Labelled with the plugin's
                     name rather than "Open plugin editor": the title above
                     is whatever the module was renamed to, so this row is
                     the one place the plugin behind the card is spelled out
                     — it carried that job as a docked button before it
                     moved in here. The verb rides in the hint column
                     instead of in front of the name, so a long plugin name
                     loses nothing to a prefix. -->
                <button
                  class="menu-row"
                  disabled={module.missing}
                  onclick={() => {
                    onOpen();
                    menuOpen = false;
                  }}
                >
                  <ArrowSquareOutIcon size={15} weight="regular" aria-hidden="true" />
                  <span class="menu-row-label">{module.name}</span>
                  <span class="menu-row-hint">{module.missing ? 'missing' : 'open'}</span>
                </button>
                {#if canEditKnobs}
                  <!-- The control editor's switch. Near the top because it is
                     the one row that changes what the card *is* rather than
                     how it looks, and it closes the panel: what it turns on
                     is the grid underneath, which the panel would be
                     sitting over. Absent — not disabled — on a card that
                     cannot offer it (a missing plugin), the same way the
                     affordances themselves are simply not there. -->
                  <button
                    class="menu-row"
                    class:menu-row-active={knobEditing}
                    aria-pressed={knobEditing}
                    onclick={() => {
                      onToggleKnobEditing?.();
                      menuOpen = false;
                    }}
                  >
                    <SlidersHorizontalIcon size={15} weight="regular" aria-hidden="true" />
                    <span class="menu-row-label">Edit controls</span>
                    <span class="menu-row-hint">{knobEditing ? 'on' : 'off'}</span>
                  </button>
                {/if}
                <!-- Clear-first: one row that learns while unbound and clears
                   once it is, the same contract as every knob's learn. The
                   label carries "MIDI" itself now that no heading does —
                   and once bound it is replaced by the trigger, which names
                   the protocol in its own first word (`CC 64 · ch 1`). -->
                <button
                  class="menu-row"
                  class:menu-row-active={!!module.midi}
                  aria-pressed={moduleMidiLearning}
                  onclick={toggleModuleMidi}
                  aria-label={module.midi
                    ? 'Clear the MIDI on/off trigger'
                    : 'Learn a MIDI on/off trigger'}
                >
                  <PianoKeysIcon size={15} weight="regular" aria-hidden="true" />
                  <span class="menu-row-label"
                    >{module.midi
                      ? describeTrigger(module.midi)
                      : moduleMidiLearning
                        ? 'Listening — press a switch'
                        : 'MIDI on/off trigger'}</span
                  >
                  {#if module.midi}
                    <span class="menu-row-hint">clear</span>
                  {:else if !moduleMidiLearning}
                    <span class="menu-row-hint">learn</span>
                  {/if}
                </button>
                <!-- The card's look: four pickers with sixteen icons among
                   them, more height than the whole menu, and the part
                   visited least — a module is coloured once, when it is
                   built, while the rows above it are used every session. So
                   it is a page, and this row is the way in: a caret rather
                   than a hint word, the one row that goes somewhere instead
                   of doing something. The swatch beside it is what the page
                   otherwise costs — the module's colour, still reported
                   from the list. -->
                <button class="menu-row nav-row" onclick={() => (menuPage = 'appearance')}>
                  <PaletteIcon size={15} weight="regular" aria-hidden="true" />
                  <span class="menu-row-label">Appearance</span>
                  <span
                    class="menu-row-dot"
                    class:menu-row-dot-none={!module.color}
                    style={module.color ? `--swatch:${module.color}` : undefined}
                    aria-hidden="true"
                  ></span>
                  <CaretRightIcon size={13} weight="bold" aria-hidden="true" />
                </button>
                <!-- Remove, last: the menu counterpart of dragging the card
                     onto the Remove pill, quiet at rest and red on hover the
                     way a patch tile's delete is. Last because it is the one
                     row that destroys what the others configure. -->
                <button
                  class="menu-row danger-row"
                  onclick={() => {
                    menuOpen = false;
                    onRemove();
                  }}
                >
                  <TrashIcon size={15} weight="regular" aria-hidden="true" />
                  <span class="menu-row-label">Remove module</span>
                </button>
              </div>
            {:else}
              <!-- The back button carries the page's title rather than
                   sitting beside one: the whole strip is the way out, so
                   there is no dead heading to aim past. -->
              <button class="menu-back" onclick={() => (menuPage = 'main')}>
                <CaretLeftIcon size={13} weight="bold" aria-hidden="true" />
                <span>Appearance</span>
              </button>
              <div class="appearance-page">
                <section>
                  <h4 class="style-heading">Colour</h4>
                  <div class="color-palette" role="radiogroup" aria-label="Module colour">
                    {#each PALETTE as c (c.value)}
                      <button
                        class="swatch"
                        class:swatch-selected={module.color === c.value}
                        style={`--swatch:${c.value}`}
                        onclick={() => pickColor(c.value)}
                        onpointerenter={() => (previewColor = c.value)}
                        onpointerleave={() => (previewColor = null)}
                        onfocus={() => (previewColor = c.value)}
                        onblur={() => (previewColor = null)}
                        aria-label={c.name}
                        {@attach tooltip(c.name)}
                        role="radio"
                        aria-checked={module.color === c.value}
                      ></button>
                    {/each}
                    <!-- Free pick, styled as a ninth swatch. The native dialog
                     previews live via `input` and commits once on `change`,
                     so a drag around the wheel is one persisted edit. -->
                    <input
                      type="color"
                      class="swatch swatch-custom"
                      class:swatch-selected={customColorActive}
                      value={module.color ?? '#14b8a6'}
                      oninput={(e) => (previewColor = e.currentTarget.value)}
                      onchange={(e) => {
                        previewColor = null;
                        pickColor(e.currentTarget.value);
                      }}
                      aria-label="Custom colour"
                      {@attach tooltip('Custom colour')}
                    />
                    <button
                      class="swatch swatch-none"
                      class:swatch-selected={!module.color}
                      onclick={() => pickColor('')}
                      onpointerenter={() => (previewColor = '')}
                      onpointerleave={() => (previewColor = null)}
                      onfocus={() => (previewColor = '')}
                      onblur={() => (previewColor = null)}
                      aria-label="No colour"
                      {@attach tooltip('No colour')}
                      role="radio"
                      aria-checked={!module.color}
                    ></button>
                  </div>
                </section>
                <section>
                  <h4 class="style-heading">Style</h4>
                  <div class="option-row" role="radiogroup" aria-label="Card style">
                    {#each MODULE_STYLE_VARIANTS as v (v)}
                      <button
                        class="option-pill"
                        class:option-selected={currentVariant === v}
                        onclick={() => pickVariant(v)}
                        onpointerenter={() => (previewVariant = v === 'subtle' ? '' : v)}
                        onpointerleave={() => (previewVariant = null)}
                        onfocus={() => (previewVariant = v === 'subtle' ? '' : v)}
                        onblur={() => (previewVariant = null)}
                        role="radio"
                        aria-checked={currentVariant === v}>{VARIANT_LABELS[v]}</button
                      >
                    {/each}
                  </div>
                </section>
                <section>
                  <h4 class="style-heading">Icon</h4>
                  <div class="icon-grid" role="radiogroup" aria-label="Module icon">
                    {#each MODULE_ICONS as ic (ic)}
                      <button
                        class="icon-cell"
                        class:option-selected={module.icon === ic}
                        onclick={() => pickIcon(ic)}
                        onpointerenter={() => (previewIcon = ic)}
                        onpointerleave={() => (previewIcon = null)}
                        onfocus={() => (previewIcon = ic)}
                        onblur={() => (previewIcon = null)}
                        aria-label={MODULE_GLYPHS[ic].label}
                        {@attach tooltip(MODULE_GLYPHS[ic].label)}
                        role="radio"
                        aria-checked={module.icon === ic}
                      >
                        <ModuleGlyph icon={ic} size={20} />
                      </button>
                    {/each}
                    <button
                      class="icon-cell option-none"
                      class:option-selected={!module.icon}
                      onclick={() => pickIcon(null)}
                      onpointerenter={() => (previewIcon = '')}
                      onpointerleave={() => (previewIcon = null)}
                      onfocus={() => (previewIcon = '')}
                      onblur={() => (previewIcon = null)}
                      aria-label="No icon"
                      {@attach tooltip('No icon')}
                      role="radio"
                      aria-checked={!module.icon}
                    ></button>
                  </div>
                </section>
                <section>
                  <h4 class="style-heading">Texture</h4>
                  <div class="option-row" role="radiogroup" aria-label="Card texture">
                    {#each MODULE_TEXTURES as t (t)}
                      <button
                        class={`texture-chip texture-${t}`}
                        class:option-selected={module.texture === t}
                        onclick={() => pickTexture(t)}
                        onpointerenter={() => (previewTexture = t)}
                        onpointerleave={() => (previewTexture = null)}
                        onfocus={() => (previewTexture = t)}
                        onblur={() => (previewTexture = null)}
                        aria-label={TEXTURE_LABELS[t]}
                        {@attach tooltip(TEXTURE_LABELS[t])}
                        role="radio"
                        aria-checked={module.texture === t}
                      ></button>
                    {/each}
                    <button
                      class="texture-chip option-none"
                      class:option-selected={!module.texture}
                      onclick={() => pickTexture(null)}
                      onpointerenter={() => (previewTexture = '')}
                      onpointerleave={() => (previewTexture = null)}
                      onfocus={() => (previewTexture = '')}
                      onblur={() => (previewTexture = null)}
                      aria-label="No texture"
                      {@attach tooltip('No texture')}
                      role="radio"
                      aria-checked={!module.texture}
                    ></button>
                  </div>
                </section>
              </div>
            {/if}
          </div>
        </Popover>
      </div>
    </div>
  {/if}
</div>

<style>
  .module-panel {
    /* Shared radius for every docked control on this card. */
    --dock-radius: 8px;
    /* Three layers, always, in this order: the drop shadow, the coloured glow,
       the inner highlight. box-shadow only interpolates between lists of equal
       length, so a hover state that adds a glow to a two-layer base doesn't
       animate at all — it snaps. The middle layer is therefore carried here as
       a fully transparent placeholder at the hover geometry, and every hover
       rule below (plain, tinted, missing) restates all three. Adding a fourth
       layer anywhere means adding it everywhere, or that rule goes back to
       snapping. */
    box-shadow:
      var(--shadow-panel),
      0 0 24px transparent,
      inset 0 1px 0 color-mix(in srgb, var(--color-ink) 10%, transparent);
    transition:
      background 0.3s ease,
      border-color 0.3s ease,
      box-shadow 0.3s ease;
  }
  .module-panel:hover {
    border-color: color-mix(in srgb, var(--color-ink) 30%, transparent);
    box-shadow:
      0 30px 60px color-mix(in srgb, var(--color-void) 70%, transparent),
      0 0 24px transparent,
      inset 0 1px 0 color-mix(in srgb, var(--color-ink) 15%, transparent);
  }

  /* Bypassed (off): let the panel go see-through so the lane shows behind it,
     and fade + desaturate its content — a clearly "off" ghosted look. The fade
     is applied to the content (title + body) rather than the whole panel, so
     the power button stays fully crisp on hover. Edit mode gets the identical
     treatment: an off module has to read as off while its chain is edited, and
     the docked controls carry their own backing so they stay legible over it. */
  .module-panel.module-bypassed {
    background: color-mix(in srgb, var(--color-panel) 12%, transparent);
    border-color: color-mix(in srgb, var(--color-ink) 10%, transparent);
    /* Transparent rather than `none`, for the same reason as the base rule:
       `none` cannot interpolate against a layer list, so the shadow would pop
       off the instant the module is switched off instead of fading with it. */
    box-shadow:
      0 25px 50px transparent,
      0 0 24px transparent,
      inset 0 1px 0 transparent;
    /* Drop the frosted blur so the lane behind shows through, instead of being
       obscured by a full-strength backdrop filter. */
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  /* Hover must not repaint the border — the tint/lift rules below would
     otherwise light an off module up as if it were running. */
  .module-panel.module-bypassed:hover {
    border-color: color-mix(in srgb, var(--color-ink) 10%, transparent);
    box-shadow:
      0 25px 50px transparent,
      0 0 24px transparent,
      inset 0 1px 0 transparent;
  }
  .module-panel.module-bypassed .module-header {
    background: transparent;
    border-bottom-color: color-mix(in srgb, var(--color-ink) 7%, transparent);
    /* Transparent, not `none`, for the same reason as the panel above. */
    box-shadow: inset 0 1px 0 transparent;
  }
  .module-panel.module-bypassed .module-title,
  .module-panel.module-bypassed .module-body {
    opacity: 0.5;
    filter: grayscale(0.85) brightness(0.85);
  }
  /* Hovering a bypassed card in edit mode lifts the content fade, so mapping
     its knobs isn't done through a grey veil; the see-through panel and dim
     border keep signalling the state meanwhile. */
  .module-panel.module-bypassed.module-editing:hover .module-title,
  .module-panel.module-bypassed.module-editing:hover .module-body,
  .module-panel.module-bypassed.module-editing:focus-within .module-title,
  .module-panel.module-bypassed.module-editing:focus-within .module-body {
    opacity: 1;
    filter: none;
  }
  .module-panel.module-editing {
    position: relative;
    overflow: visible;
  }
  .module-panel.module-editing:hover,
  .module-panel.module-editing:focus-within {
    z-index: 50;
  }
  .module-editing .module-header {
    border-radius: calc(1rem - 1px) calc(1rem - 1px) 0 0;
  }

  /* Everything inside the card's frame, in two layers that only do anything
     while the card tweens between sizes (see the FLIP effect in the script).
     The card is the only thing that should appear to move: adding a column has
     to slide the card's right edge out over a knob grid that is already sitting
     at its final position, never re-lay-out the knobs under a moving frame.
     So the outer layer tracks the animating size and clips — on this wrapper
     and never on the panel, so the docks outside the card survive it… */
  /* …and the inner layer is pinned to the size the card is animating *to*, so
     the header and the grid are laid out once, at their final geometry, and the
     growth merely uncovers the added cells. Without this the grid box would be
     squeezed to the animating width and its `justify-center` would re-centre
     every knob on every frame — the knobs sliding sideways under the frame.
     :global on the panel class: the tween toggles it imperatively, so Svelte
     can't see it in the markup and would prune these rules. */
  .module-clip,
  .module-clip-inner {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
  }
  .module-clip {
    border-radius: calc(1rem - 1px);
  }
  :global(.module-resizing) .module-clip {
    overflow: hidden;
  }
  :global(.module-resizing) .module-clip-inner {
    flex: none;
    width: var(--clip-w);
    height: var(--clip-h);
  }

  .module-header {
    background: color-mix(in srgb, var(--color-ink) 4%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--color-ink) 10%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-ink) 6%, transparent);
    transition:
      background 0.3s ease,
      border-bottom-color 0.3s ease,
      box-shadow 0.3s ease;
  }
  /* The bypass fade lives on the base rules, not on `.module-bypassed`: a
     transition declared only in the "off" rule animates the way in and snaps
     the way out, because removing the class also removes the transition that
     would have carried it back. Both directions are the same 0.3s as the
     panel's own colour fade, so the whole card settles together. */
  .module-title,
  .module-body {
    transition:
      opacity 0.3s ease,
      filter 0.3s ease;
  }
  /* The title contributes to how wide a card is — that is deliberate, and is
     why a two-word module name makes a comfortable card. What it must not do is
     *decide* it: a TONE3000 capture can be called "'02 Vox AC30/6 Top Boost
     Normal Channel Bright Cap 4", and a card sized to that is a card nothing
     else in the rack lines up with. Past what fits, the name truncates and the
     full text lives in the title's tooltip, which the header already shows for
     a renamed module.

     Both halves of that are wanted at once — ask for as much width as the name
     needs *up to 22ch*, then take every extra pixel the knob grid below makes
     available — and no single box can do both: whatever caps what the title
     asks for (`max-width`, size containment, a `flex-basis` it cannot exceed)
     caps what it may grow into as well. So the two jobs are two elements
     stacked in one box. The ghost is in flow and does the asking, capped at
     22ch (in ch, so the ask tracks the font) and hidden; the text is out of
     flow, contributes no width at all, and fills whatever the flex line
     finally hands the box — which is why the name reads from the header's left
     edge with its ellipsis at the card's right rather than stopping short of
     it. A single element with `flex-basis: 22ch` looks like it should work and
     does not: a growable flex item reports its whole max-content width when
     the card is sized to its contents, so a 55-character capture name stretched
     the card as if no basis were set. */
  .module-title {
    position: relative;
    flex-grow: 1;
    padding: 0.125rem 0.375rem;
    border: 1px solid transparent;
    color: var(--color-ink);
    font-size: 0.875rem;
    font-weight: 600;
    letter-spacing: 0.2px;
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
    text-align: left;
  }
  .module-title-ghost {
    display: block;
    max-width: 22ch;
    visibility: hidden;
  }
  /* Inset by the title's own padding: an absolute box is placed against the
     padding box, so `0` would sit it on the border edge. */
  .module-title-text {
    position: absolute;
    inset: 0.125rem 0.375rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .module-title-editable {
    cursor: pointer;
    text-align: left;
  }
  .module-title-editable:hover {
    color: var(--color-accent);
  }

  /* The origin mark in the header. A button, because it opens the tone's page;
     styled as the artwork it sits above rather than as a control, since it is a
     trademark and must not be recoloured, tinted or given a state of its own —
     only the surrounding opacity moves. */
  .tone-mark {
    display: inline-flex;
    align-items: center;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
    opacity: 0.85;
    transition: opacity 0.15s ease;
  }
  .tone-mark:hover {
    opacity: 1;
  }
  .tone-mark:disabled {
    cursor: default;
  }

  /* The tone's photograph, down the left of the body: as tall as whatever the
     capture selector and the knob rows settle on, and square.

     A frame with the image absolutely inside it, rather than the image itself
     stretched. A picture is 1200px wide before anything styles it, and an
     <img> laid out as a flex item contributes that to the row — which is how
     the card once ended up several thousand pixels across. Out of flow it
     contributes nothing, and the frame is given both dimensions from the
     measured height of the controls beside it (see `artSize`). */
  .tone-art {
    position: relative;
    flex: none;
    padding: 0;
    border: 0;
    border-radius: 8px;
    overflow: hidden;
    background: none;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-ink) 12%, transparent);
  }
  /* Only the linked form is a control; a tone with no page to open keeps the
     plain picture's cursor. */
  button.tone-art {
    cursor: pointer;
  }
  button.tone-art:hover img {
    opacity: 0.88;
  }
  .tone-art img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: opacity 0.15s ease;
  }

  /* A module with no mapped knobs renders no body while folded, so the header
     is the whole card — its separator would draw a stray line along the bottom
     edge with nothing under it to separate. The extra `.module-panel` out-
     specifies the tinted/bypassed header rules further down. */
  .module-panel .module-header:not(:has(+ .module-body)) {
    border-bottom-color: transparent;
  }

  /* --- Docked edit controls ------------------------------------------------
     Both docks are absolute layers hugging the card's outer edges, so they add
     no layout size: the card keeps its play-mode footprint in edit mode, and
     neighbouring cards never shift when the toolbars appear. Each dock is at
     least as wide as the card and centred on it, so a narrow card's toolbar
     overhangs symmetrically instead of being clipped to the card width. */
  .module-dock {
    position: absolute;
    left: 50%;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: max-content;
    min-width: 100%;
    transform: translateX(-50%);
    /* Revealed on hover, like the per-knob controls: the card at rest shows
       only its knobs. Visibility is delayed out so the buttons stay clickable
       while the pointer crosses the gap between card and dock. */
    opacity: 0;
    visibility: hidden;
    transition-property: opacity, visibility;
    transition-duration: 260ms, 0s;
    transition-timing-function: ease, linear;
    transition-delay: 0s, 260ms;
  }
  .module-panel:hover .module-dock,
  .module-panel:focus-within .module-dock,
  .module-menu-open .module-dock {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
  }
  /* The gap is hoverable too, so moving from the card to a dock button doesn't
     pass through un-hovered space and blink the dock away. */
  .module-dock::before {
    content: '';
    position: absolute;
    inset-inline: 0;
    height: 0.75rem;
  }
  /* Both docks right-align, so every control on the card stacks against the
     same edge instead of the top row splitting to both corners. */
  .module-dock-top {
    bottom: calc(100% + 0.5rem);
    justify-content: flex-end;
  }
  .module-dock-top::before {
    top: 100%;
  }
  /* The plugin-editor and patch controls dock below, on the same side as the
     top dock's arrange cluster. */
  .module-dock-bottom {
    top: calc(100% + 0.5rem);
    justify-content: flex-end;
  }
  .module-dock-bottom::before {
    bottom: 100%;
  }
  /* Dock buttons stand on their own outside the card, so each carries the
     panel backing the removed footer band used to provide — otherwise they'd
     read as translucent smudges over the rack background. */
  .module-dock :global(.patch-trigger),
  .module-dock .module-t3k-btn,
  .module-dock .module-more-btn {
    background: color-mix(in srgb, var(--color-panel) 92%, transparent);
    box-shadow: var(--shadow-panel);
    -webkit-backdrop-filter: blur(24px);
    backdrop-filter: blur(24px);
  }
  /* An armed MIDI learn is only reported by the pulsing kebab, and the pedal
     being pressed is across the room — so the dock stays out for as long as the
     learn is listening, the way it stays out for an open menu. */
  .module-learning .module-dock {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
  }

  /* Module move handle (edit mode): the header itself, like a window's title
     bar — no extra band, so the card keeps its one seamless top edge. The
     grip line pinned to the header's top edge is the cue; the whole card is
     the drag image, and the source card dims like a lifted knob tile while
     its ghost rides the cursor. */
  /* Room for the grip line: clear space above and below it, so the cue reads
     as its own band instead of crowding the title. On the editing class, not
     the grab one — the grab affordance pauses during a rename (selecting text
     is the same gesture as a drag), and the header must not change height
     when it does. */
  .module-header-editing {
    padding-top: 1rem;
  }
  .module-header-grab {
    cursor: grab;
  }
  .module-header-grab:active {
    cursor: grabbing;
  }
  .grab-line {
    position: absolute;
    top: 6px;
    left: 50%;
    width: 2rem;
    height: 3px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-ink) 28%, transparent);
    transform: translateX(-50%);
    pointer-events: none;
    transition: background 0.2s ease;
  }
  .module-header-grab:hover .grab-line {
    background: color-mix(in srgb, var(--color-accent) 70%, var(--color-ink));
  }
  .module-drag-source {
    opacity: 0.4;
  }
  /* The handle is the drag source: hover is not tracked during a drag, and
     hiding the source mid-gesture can abort it, so its dock stays revealed on
     the dragged card for the whole gesture. */
  .module-drag-source .module-dock {
    opacity: 1;
    visibility: visible;
  }

  /* User-chosen accent tint. Colours the border and the header/footer bands so
     the module reads as "owned" without overwhelming the panel. */
  .module-tinted {
    /* --module-tint, not --module-color directly: the stored colour is user
       data — free-picked, not just the palette — and each theme has to
       normalise its lightness before using it (the light theme re-clamps
       below). Everything here goes through the indirection so both themes
       share one set of rules. The dark floor only lifts colours darker than
       every palette entry, so looks saved from the palette are untouched;
       without it a near-black pick would tint the card invisibly. */
    --module-tint: oklch(from var(--module-color) max(l, 0.55) c h);
    /* Re-point the accent to the module colour so every accent-driven element
       inside the card (knob indicators, meters, LEDs, glows) adopts it. Custom
       properties cascade, so this reaches all descendants. */
    --color-accent: var(--module-tint);
    /* The shared glow tokens bake in whichever accent was in scope where they
       were declared (:root), so re-pointing the accent alone leaves them the
       default teal. Re-declare them here so they resolve against the module
       colour and inherit that way down. */
    --shadow-glow-accent:
      0 0 12px color-mix(in srgb, var(--color-accent) 50%, transparent),
      0 0 24px color-mix(in srgb, var(--color-accent) 20%, transparent);
    --shadow-glow-accent-sm: 0 4px 15px color-mix(in srgb, var(--color-accent) 20%, transparent);
    --text-shadow-glow-accent:
      0 0 12px color-mix(in srgb, var(--color-accent) 50%, transparent),
      0 0 24px color-mix(in srgb, var(--color-accent) 20%, transparent);
    --text-shadow-glow-accent-sm: 0 0 5px color-mix(in srgb, var(--color-accent) 40%, transparent);
    border-color: color-mix(in srgb, var(--module-tint) 55%, transparent);
    /* background-color, not the shorthand: textures live in background-image
       on the same element, and the shorthand would wipe them. */
    background-color: color-mix(in srgb, var(--module-tint) 9%, var(--color-panel));
  }
  .module-tinted:hover {
    border-color: color-mix(in srgb, var(--module-tint) 80%, transparent);
    box-shadow:
      0 30px 60px color-mix(in srgb, var(--color-void) 70%, transparent),
      0 0 24px color-mix(in srgb, var(--module-tint) 22%, transparent),
      inset 0 1px 0 color-mix(in srgb, var(--color-ink) 15%, transparent);
  }
  .module-tinted .module-header {
    background-color: color-mix(in srgb, var(--module-tint) 16%, transparent);
    border-bottom-color: color-mix(in srgb, var(--module-tint) 32%, transparent);
  }

  /* Style variants: how strongly the card wears its colour. Subtle is the
     default rules above (no class). Scoped under .module-tinted — a variant
     with no colour has nothing to vary — and expressed through --module-tint,
     so both themes' lightness clamps keep working with no extra rules. */
  .module-tinted.variant-bold {
    background-color: color-mix(in srgb, var(--module-tint) 26%, var(--color-panel));
    border-color: color-mix(in srgb, var(--module-tint) 85%, transparent);
  }
  .module-tinted.variant-bold .module-header {
    background-color: color-mix(in srgb, var(--module-tint) 42%, transparent);
    border-bottom-color: color-mix(in srgb, var(--module-tint) 55%, transparent);
  }
  .module-tinted.variant-outline {
    background-color: var(--color-panel);
    border-color: color-mix(in srgb, var(--module-tint) 90%, transparent);
  }
  .module-tinted.variant-outline .module-header {
    background-color: color-mix(in srgb, var(--module-tint) 10%, transparent);
    border-bottom-color: color-mix(in srgb, var(--module-tint) 60%, transparent);
  }

  /* Textures: background-image only, so they layer under whatever
     background-color the tint rules above chose, with or without a colour.
     Drawn from the theme's ink/void so both themes shade them natively —
     except the tolex noise, whose data-URI grain is theme-fixed dark and
     quiet enough (α 0.10) to pass on a light panel. */
  .texture-metal {
    background-image:
      repeating-linear-gradient(
        180deg,
        color-mix(in srgb, var(--color-ink) 4%, transparent) 0 1px,
        transparent 1px 3px
      ),
      linear-gradient(
        105deg,
        transparent 40%,
        color-mix(in srgb, var(--color-ink) 6%, transparent) 50%,
        transparent 60%
      );
  }
  .texture-tolex {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.38' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.28 0'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 120px 120px;
  }
  .texture-carbon {
    background-image:
      radial-gradient(color-mix(in srgb, var(--color-void) 35%, transparent) 15%, transparent 16%),
      radial-gradient(color-mix(in srgb, var(--color-void) 35%, transparent) 15%, transparent 16%),
      radial-gradient(color-mix(in srgb, var(--color-ink) 6%, transparent) 15%, transparent 20%),
      radial-gradient(color-mix(in srgb, var(--color-ink) 6%, transparent) 15%, transparent 20%);
    background-size: 12px 12px;
    background-position:
      0 0,
      6px 6px,
      0 1px,
      6px 7px;
  }

  /* Light theme. Two things have to be restated here rather than inherited:

     1. The palette is tuned for dark panels — Amber and Green land near 2:1 on
        a white card. Clamping every entry to one OKLCH lightness keeps its hue
        (so the swatch still names the colour) while making the eight read as
        one family at a legible weight, instead of eight different loudnesses.
     2. The glow tokens above hardcode the dark theme's *shape*, because they
        have to be re-derived from the module's accent and CSS gives no way to
        inherit a shadow's geometry separately from its colour. Same trade as
        the root-level light block in app.css — keep the two in sync. */
  :global(:root[data-theme='light']) .module-tinted {
    --module-tint: oklch(from var(--module-color) 0.52 c h);
    --shadow-glow-accent:
      0 1px 3px color-mix(in srgb, var(--color-accent) 45%, transparent),
      0 3px 10px color-mix(in srgb, var(--color-accent) 22%, transparent);
    --shadow-glow-accent-sm: 0 2px 8px color-mix(in srgb, var(--color-accent) 18%, transparent);
    --text-shadow-glow-accent: none;
    --text-shadow-glow-accent-sm: none;
  }
  /* Relative colour syntax needs Chromium 119+. WebView2 is far newer, but the
     raw stored colour degrades acceptably if it ever isn't. */
  @supports not (color: oklch(from white l c h)) {
    .module-tinted,
    :global(:root[data-theme='light']) .module-tinted {
      --module-tint: var(--module-color);
    }
  }

  .color-palette {
    display: grid;
    grid-template-columns: repeat(5, auto);
    gap: 8px;
  }
  .swatch {
    width: 24px;
    height: 24px;
    border: 2px solid transparent;
    /* The panel is portaled to <body>, so the card's --dock-radius is out of
       scope here; every rule in it carries the same literal fallback. */
    border-radius: var(--dock-radius, 8px);
    background: var(--swatch);
    box-shadow: inset 0 1px 2px color-mix(in srgb, var(--color-void) 40%, transparent);
    cursor: pointer;
    transition: transform 0.15s ease;
  }
  .swatch:hover {
    transform: scale(1.15);
  }
  .swatch-selected {
    border-color: var(--color-ink);
    box-shadow: 0 0 10px color-mix(in srgb, var(--swatch, var(--color-ink)) 55%, transparent);
  }

  /* The "clear colour" swatch: a hollow circle with a diagonal slash. */
  .swatch-none {
    background:
      linear-gradient(
        to top left,
        transparent calc(50% - 1px),
        color-mix(in srgb, var(--color-danger) 80%, transparent) calc(50% - 1px),
        color-mix(in srgb, var(--color-danger) 80%, transparent) calc(50% + 1px),
        transparent calc(50% + 1px)
      ),
      color-mix(in srgb, var(--color-ink) 8%, transparent);
    border-color: color-mix(in srgb, var(--color-ink) 25%, transparent);
  }
  .swatch-none.swatch-selected {
    border-color: var(--color-ink);
  }

  /* The custom-colour well: a native colour input dressed as a ninth swatch,
     ringed by a colour wheel so it reads as "any colour" next to the fixed
     eight. The inner webkit swatch shows the current value. */
  .swatch-custom {
    appearance: none;
    padding: 3px;
    background: conic-gradient(
      #ef4444,
      #f59e0b,
      #22c55e,
      #14b8a6,
      #3b82f6,
      #8b5cf6,
      #ec4899,
      #ef4444
    );
    cursor: pointer;
  }
  .swatch-custom::-webkit-color-swatch-wrapper {
    padding: 0;
  }
  .swatch-custom::-webkit-color-swatch {
    border: none;
    border-radius: 3px;
  }

  /* The options panel: a list of rows, plus the appearance pickers when the
     last one is open. */
  .style-sections {
    display: flex;
    width: 218px;
    min-height: 0;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    padding: 10px;
  }
  /* Rows sit closer to each other than the panel's own gap: with the headings
     gone they are one list to run an eye down, not four separate things. */
  .menu-rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .style-heading {
    margin: 0 0 6px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.8px;
    color: var(--color-muted);
    text-transform: uppercase;
  }
  .option-row {
    display: flex;
    gap: 6px;
  }
  .option-pill {
    flex: 1;
    padding: 4px 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-muted);
    border: 1px solid color-mix(in srgb, var(--color-ink) 12%, transparent);
    border-radius: var(--dock-radius, 8px);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      color 0.15s ease;
  }
  .icon-grid {
    display: grid;
    grid-template-columns: repeat(5, auto);
    gap: 6px;
  }
  .icon-cell {
    display: inline-flex;
    width: 34px;
    height: 34px;
    align-items: center;
    justify-content: center;
    color: var(--color-muted);
    border: 1px solid color-mix(in srgb, var(--color-ink) 12%, transparent);
    border-radius: var(--dock-radius, 8px);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      color 0.15s ease;
  }
  /* Texture chips carry the real texture classes, so each chip is its own
     preview on the panel background. */
  .texture-chip {
    flex: 1;
    height: 26px;
    background-color: color-mix(in srgb, var(--color-ink) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-ink) 12%, transparent);
    border-radius: var(--dock-radius, 8px);
    cursor: pointer;
    transition: border-color 0.15s ease;
  }
  .option-pill:hover,
  .icon-cell:hover,
  .texture-chip:hover {
    color: var(--color-ink);
    border-color: color-mix(in srgb, var(--color-ink) 35%, transparent);
  }
  /* The "clear" cell shared by the icon and texture rows: the same diagonal
     slash as the no-colour swatch. */
  .option-none {
    background:
      linear-gradient(
        to top left,
        transparent calc(50% - 1px),
        color-mix(in srgb, var(--color-danger) 80%, transparent) calc(50% - 1px),
        color-mix(in srgb, var(--color-danger) 80%, transparent) calc(50% + 1px),
        transparent calc(50% + 1px)
      ),
      color-mix(in srgb, var(--color-ink) 8%, transparent);
  }
  .option-selected {
    color: var(--color-ink);
    border-color: var(--color-ink);
  }

  /* The header glyph wears the accent in scope — the module's tint when it
     has one, the app accent otherwise — matching the knob indicators. */
  .module-glyph {
    display: inline-flex;
    color: var(--color-accent);
  }

  /* Floating parameter pickers share the dock controls' opaque panel chrome. */
  .module-panel :global(.knob-param-select) {
    padding: 0.35rem 0.5rem;
    border-radius: var(--dock-radius);
    border-color: color-mix(in srgb, var(--color-ink) 10%, transparent);
    background: color-mix(in srgb, var(--color-panel) 92%, transparent);
    color: var(--color-ink);
    font-size: 0.7rem;
    box-shadow: var(--shadow-panel);
    -webkit-backdrop-filter: blur(24px);
    backdrop-filter: blur(24px);
    transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
  }
  .module-panel :global(.knob-param-select:enabled:hover) {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 15%, var(--color-panel));
    color: var(--color-accent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 25%, transparent);
  }

  /* Destructive knob action's danger treatment. (Removing the module itself
     is a drag onto the remove zone, not a button — see the grab strip.) */
  .knob-remove-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--color-danger) 40%, transparent);
    background: color-mix(in srgb, var(--color-danger) 14%, var(--color-panel));
    color: color-mix(in srgb, var(--color-danger) 85%, var(--color-ink));
    box-shadow: var(--shadow-panel);
    -webkit-backdrop-filter: blur(24px);
    backdrop-filter: blur(24px);
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
  }
  .knob-remove-btn {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 7px;
  }
  .knob-remove-btn:hover {
    border-color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 30%, var(--color-panel));
    color: var(--color-ink);
    box-shadow: 0 0 14px color-mix(in srgb, var(--color-danger) 35%, transparent);
  }

  .knob-option-btn {
    display: inline-flex;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--color-ink) 22%, var(--color-panel));
    border-radius: 7px;
    background: var(--color-panel);
    color: var(--color-muted);
    box-shadow: var(--shadow-panel);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .knob-option-btn:hover,
  .knob-option-active {
    border-color: color-mix(in srgb, var(--color-accent) 65%, var(--color-panel));
    background: color-mix(in srgb, var(--color-accent) 15%, var(--color-panel));
    color: var(--color-accent);
  }

  /* Centred on the control widget itself, not on the cell: Knob/Switch/Meter all
     render a fixed 44px widget at the top of their column with the label below,
     so the widget's midline sits 22px down from the cell's top edge. */
  .knob-option-mid {
    top: 22px;
    transform: translateY(-50%);
  }

  /* Header MIDI-learn control for the bypass trigger: the bypass button's
     quiet sibling, and revealed the same way — only while the card is hovered
     (or keyboard-focused), like the power button and the knob hover controls.
     An armed learn stays visible through the state utilities on the button, so
     "Listening" survives the pointer leaving for the pedal. */
  .midi-listening {
    opacity: 1 !important;
    visibility: visible !important;
    border-color: var(--color-accent) !important;
    color: var(--color-accent) !important;
    animation: learn-pulse 1.2s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .midi-listening {
      animation: none;
    }
  }

  /* The kebab that opens the module's options, in the bottom dock beside the
     patch pill. It carries no reveal rules of its own any more: the dock it
     lives in is what fades in on hover, and holding it visible while its menu
     is open is already `.module-menu-open .module-dock`. Shaped as the patch
     pill's square sibling — same height, same radius, same border — so the two
     read as one toolbar rather than a pill with a circle stuck to it. */
  .module-more-btn {
    display: inline-flex;
    /* Square by construction rather than by a measurement: a square icon inside
       equal padding on all four sides. `aspect-ratio` cannot do it here — a
       flex item's cross size is not definite while its main size is being
       resolved, so the ratio has nothing to transfer from and the width falls
       back to the icon's own 18px, which is the narrow chip this replaced. The
       padding is the patch pill's own `py`, so the two are the same height
       without either being told a number. `line-height: 0` keeps the icon's box
       from inheriting text leading and stretching the square. */
    padding: 0.35rem;
    line-height: 0;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--color-ink) 10%, transparent);
    border-radius: var(--dock-radius, 6px);
    background: color-mix(in srgb, var(--color-ink) 3%, transparent);
    color: color-mix(in srgb, var(--color-ink) 75%, transparent);
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
  }
  /* Hover, focus and the open state all light the same accent ring the patch
     pill lights, so the control under the pointer is unmistakable and an open
     menu keeps its trigger marked while the panel is elsewhere on screen. */
  .module-more-btn:hover,
  .module-more-btn:focus-visible,
  .module-more-btn[aria-expanded='true'] {
    border-color: var(--color-accent);
    background-color: color-mix(in srgb, var(--color-accent) 15%, var(--color-panel));
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 25%, transparent);
    color: var(--color-accent);
  }
  /* A bound on/off trigger is the one piece of state the menu hides, so the
     button carries it. */
  .module-more-btn.module-more-bound {
    color: var(--color-accent);
  }

  /* The TONE3000 button at the other end of the same dock, built to the patch
     pill's own metrics rather than the kebab's — same font size, same padding,
     a word of its own — so the two pills are one height without either being
     told a number. The word is "Browse", not "TONE3000": the mark beside it
     already says whose catalogue this is, and repeating it would set the
     wordmark twice in one control. The artwork is never recoloured (see
     Tone3000Logo), so only the frame and the label react to hover. */
  .module-t3k-btn {
    display: inline-flex;
    gap: 0.375rem;
    padding: 0.35rem 0.5rem;
    font-size: 0.7rem;
    color: var(--color-ink);
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--color-ink) 10%, transparent);
    border-radius: var(--dock-radius, 6px);
    background: color-mix(in srgb, var(--color-ink) 3%, transparent);
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
  }
  .module-t3k-btn:hover,
  .module-t3k-btn:focus-visible {
    border-color: var(--color-accent);
    background-color: color-mix(in srgb, var(--color-accent) 15%, var(--color-panel));
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 25%, transparent);
    color: var(--color-accent);
  }

  /* A full-width action row in the options menu (the MIDI learn). Reads as a
     line of the menu rather than as a chip, since it has a sentence to say. */
  .menu-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid color-mix(in srgb, var(--color-ink) 12%, transparent);
    border-radius: var(--dock-radius, 8px);
    background: transparent;
    color: var(--color-muted);
    font-size: 11px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      color 0.15s ease;
  }
  .menu-row:enabled:hover {
    color: var(--color-ink);
    border-color: color-mix(in srgb, var(--color-ink) 35%, transparent);
  }
  /* The one row that can be offered and still refused: a missing plugin has no
     editor to open, and the row says which plugin is missing. */
  .menu-row:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* The destructive row: the same quiet grey as its neighbours at rest, so
     the menu does not shout, and unmistakably red the moment it is aimed
     at — the same contract as a patch tile's delete button. */
  .danger-row:enabled:hover {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  }
  /* The Appearance row: the one row that navigates. Its caret leans on the
     right edge where the other rows put their verb, so "goes somewhere" and
     "does something" are told apart without reading either. */
  .nav-row :global(svg:last-child) {
    flex: none;
    color: var(--color-muted);
  }
  /* The back button, which is also the page's title. Full width so it is hard
     to miss and easy to hit, and quieter than a menu row — it is the way out,
     not one of the choices. */
  .menu-back {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 6px;
    padding: 4px 2px;
    border: 0;
    background: transparent;
    color: var(--color-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.2px;
    text-align: left;
    cursor: pointer;
    transition: color 0.15s ease;
  }
  .menu-back:hover {
    color: var(--color-ink);
  }
  /* The four pickers, one under the other. No rule down the left and no
     indent: the page is the group now, and its own edge is the panel's. */
  .appearance-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .menu-row-dot {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--swatch);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-void) 35%, transparent);
  }
  /* No colour: the same hollow slash the palette's own clear swatch wears, so
     the two say the same thing in the same shape. */
  .menu-row-dot-none {
    background:
      linear-gradient(
        to top left,
        transparent calc(50% - 1px),
        color-mix(in srgb, var(--color-muted) 70%, transparent) calc(50% - 1px),
        color-mix(in srgb, var(--color-muted) 70%, transparent) calc(50% + 1px),
        transparent calc(50% + 1px)
      ),
      transparent;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-ink) 20%, transparent);
  }
  .menu-row-active {
    color: var(--color-accent);
    border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  }
  .menu-row-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-row-hint {
    flex: none;
    color: var(--color-muted);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
  }
  /* Stacked under .knob-option-mid: that button's 28px box ends 14px past the
     midline, so this clears it by 4px. */
  .knob-option-below {
    top: 40px;
  }

  /* Hover controls fade normally with no delayed-hide grace period. */
  .knob-hover-control {
    opacity: 0;
    visibility: hidden;
    pointer-events: auto;
    transition-property: opacity, visibility;
    transition-duration: 260ms, 0s;
    transition-timing-function: ease, linear;
    transition-delay: 0s, 260ms;
  }
  .group:hover .knob-hover-control,
  .knob-hover-control:hover {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
  }
  /* While the card tweens between sizes, .module-clip clips to the animating
     edge — and these buttons overhang the card, so they'd render cut off at
     the border for the duration. Hold them hidden until the card settles;
     they then do their normal fade-in. The second selector out-specifies the
     hover reveal above. */
  :global(.module-resizing) .knob-hover-control,
  :global(.module-resizing) .group:hover .knob-hover-control {
    opacity: 0;
    visibility: hidden;
  }

  /* Drag-to-reorder (edit mode). Reordering starts from the dedicated handle
     below the remove button, so the control itself keeps its own cursor and
     gesture; the lifted tile follows the pointer while its siblings glide into
     place via animate:flip. */
  .knob-drag-btn {
    cursor: grab;
  }
  .knob-drag-btn:active {
    cursor: grabbing;
  }
  /* The handle is the drag source, so it must stay visible for the whole drag:
     hover is not tracked while a drag is in flight, and hiding the source
     mid-gesture can abort it. */
  .knob-dragging .knob-drag-btn {
    opacity: 1;
    visibility: visible;
  }
  .knob-reorderable {
    transition:
      transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1),
      opacity 0.2s ease;
  }
  .knob-reorderable:active {
    cursor: grabbing;
  }
  .knob-dragging {
    opacity: 0.45;
    transform: scale(1.08);
    z-index: 20;
  }

  /* Empty cells are add controls at rest and drop targets during a drag. */
  .knob-slot {
    align-self: stretch;
    min-height: 4rem;
    border: 1px dashed transparent;
    border-radius: 8px;
    transition: all 0.2s ease;
  }
  .knob-slot :global(.knob-add) {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 4rem;
    align-items: center;
    justify-content: center;
    border: 1px dashed color-mix(in srgb, var(--color-ink) 20%, transparent);
    border-radius: 8px;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .knob-slot :global(.knob-add):hover {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 8%, transparent);
    color: var(--color-accent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 18%, transparent);
  }
  .knob-add-plus {
    font-size: 1.4rem;
    font-weight: 300;
    line-height: 1;
  }
  .knob-slot-active {
    border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
  }
  .knob-slot-over {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 14%, transparent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 20%, transparent);
  }

  /* Compact power control: state is carried by contrast, not a bright LED.
     Hidden until the module (or one of its controls) is hovered/focused. */
  .bypass-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    transition-property: opacity, visibility;
    transition-duration: 260ms, 0s;
    transition-timing-function: ease, linear;
    transition-delay: 0s, 260ms;
  }
  .module-panel:hover .bypass-wrap,
  .module-panel:has(:focus-visible) .bypass-wrap {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
  }
  /* A pending toggle keeps the control revealed (with its solid chip backing)
     even without hover, so the spinner stays in view until the engine echoes
     the new state. */
  .module-panel .bypass-wrap.bypass-pending {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
    cursor: progress;
  }
  .module-panel .bypass-wrap.bypass-pending input[type='checkbox'] {
    background-color: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel-solid));
    border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
    cursor: progress;
  }
  /* Holds the power switch alone now that the options kebab has moved to the
     dock. Kept as a box rather than dissolved into the header, because the
     float below is a property of the cluster's position, not of the switch. */
  .header-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
  }
  /* Folded (play mode, and any card in edit mode whose control editor is off):
     float over the right end of the title so it reserves no header width and
     covers the title only where they overlap, keeping a folded card exactly as
     wide as it is in play mode. It is only visible on hover, and in edit mode
     the kebab under it is how the control editor is switched on — so this is
     the state the gesture starts from rather than one that is never seen. */
  .module-panel:not(.module-expanded) .header-actions {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    /* Above the faded content so the toggle stays crisp on a bypassed module. */
    z-index: 2;
  }
  /* When revealed, back the toggle with a solid chip so it reads as a crisp,
     fully opaque control — whether the module is on (frosted) or off (the
     see-through state, where a translucent chip would let the lane bleed
     through). The same neutral chip the kebab beside it wears, deliberately:
     they are one cluster of two circles, and an accent ring on only one of them
     read as a state the other lacked rather than as the same kind of control.
     Accent is now what either one wears under the pointer, and nothing else —
     except a pending toggle, where it marks work in flight.

     The power switch still says on/off by contrast, in its icon (see
     `.bypass-icon`) rather than in its ring. */
  .module-panel:hover .bypass-wrap input[type='checkbox'],
  .module-panel:has(:focus-visible) .bypass-wrap input[type='checkbox'] {
    background-color: color-mix(in srgb, var(--color-ink) 8%, var(--color-panel-solid));
    border-color: color-mix(in srgb, var(--color-ink) 16%, transparent);
  }
  /* Direct hover on the toggle itself lifts it further — brighter fill, a lit
     ring, and a soft glow — so the control is unmistakable. Also on keyboard
     focus. Prefixed with the module hover/focus so it out-specifies the
     revealed backing rule above. */
  .module-panel:hover .bypass-wrap:hover input[type='checkbox'],
  .module-panel:has(:focus-visible) .bypass-wrap input[type='checkbox']:focus-visible {
    background-color: color-mix(in srgb, var(--color-accent) 18%, var(--color-panel-solid));
    border-color: var(--color-accent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 30%, transparent);
  }
  .module-panel:hover .bypass-wrap:hover .bypass-icon,
  .module-panel:has(:focus-visible)
    .bypass-wrap
    input[type='checkbox']:focus-visible
    + .bypass-icon {
    color: var(--color-accent);
  }
  .bypass-wrap input[type='checkbox'] {
    appearance: none;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: transparent;
    border: 1px solid transparent;
    margin: 0;
    cursor: pointer;
    outline: none;
    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      box-shadow 150ms ease;
  }
  .bypass-wrap input[type='checkbox']:checked {
    background-color: color-mix(in srgb, var(--color-ink) 8%, transparent);
    border-color: color-mix(in srgb, var(--color-ink) 16%, transparent);
  }
  .bypass-wrap input[type='checkbox']:focus-visible {
    border-color: color-mix(in srgb, var(--color-ink) 55%, transparent);
  }
  .bypass-icon {
    position: absolute;
    display: flex;
    pointer-events: none;
    color: color-mix(in srgb, var(--color-ink) 60%, transparent);
    transition: color 150ms ease;
  }
  .bypass-wrap input[type='checkbox']:checked + .bypass-icon {
    color: color-mix(in srgb, var(--color-ink) 90%, transparent);
  }

  /* --- Missing plugin ------------------------------------------------------
     The hosted plugin could not be loaded (uninstalled, or failing), so the
     card is a placeholder: the amber dashed frame and badge say "not running",
     the ghosted body says its controls are inert, and audio passes through as
     if the module were switched off. Declared last so the warning wears down
     a user-chosen tint and the hover lift alike. */
  .module-panel.module-missing {
    --missing: #f59e0b;
    border-style: dashed;
    border-color: color-mix(in srgb, var(--missing) 50%, transparent);
    background: color-mix(in srgb, var(--missing) 6%, var(--color-panel));
  }
  .module-panel.module-missing:hover {
    border-color: color-mix(in srgb, var(--missing) 75%, transparent);
    box-shadow:
      0 30px 60px color-mix(in srgb, var(--color-void) 70%, transparent),
      0 0 24px color-mix(in srgb, var(--missing) 18%, transparent),
      inset 0 1px 0 color-mix(in srgb, var(--color-ink) 15%, transparent);
  }
  .module-panel.module-missing .module-header {
    background: color-mix(in srgb, var(--missing) 12%, transparent);
    border-bottom-color: color-mix(in srgb, var(--missing) 28%, transparent);
  }
  /* The knob layout stays visible — it is user data worth keeping in sight —
     but inert: there is no plugin to write to, so a turnable knob would lie. */
  .module-panel.module-missing .module-body {
    pointer-events: none;
    opacity: 0.4;
    filter: grayscale(0.9);
  }
  .missing-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid color-mix(in srgb, var(--missing) 55%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--missing) 16%, transparent);
    color: color-mix(in srgb, var(--missing) 80%, var(--color-ink));
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  /* The amber is tuned for dark panels; clamp its lightness on the light theme
     the way the module palette is clamped, so badge and frame keep contrast on
     a white card. Same @supports trade-off as the palette clamp above. */
  :global(:root[data-theme='light']) .module-panel.module-missing {
    --missing: oklch(from #f59e0b 0.55 c h);
  }
</style>

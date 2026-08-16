<script lang="ts">
  import { DotsSixVerticalIcon } from 'phosphor-svelte';
  import Tone3000Logo from './Tone3000Logo.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';

  /**
   * The drawer's way into TONE3000.
   *
   * Dragged onto the rack exactly like a patch tile, and for the same reason:
   * the drop is the user saying *where* the module goes. TONE3000's own window
   * opens once the tile lands, and whatever tone they pick over there is
   * inserted at that position — so choosing a place and choosing a tone stay
   * two separate, undoable steps rather than one modal guess. Clicking opens
   * the same window, for when the position does not matter yet.
   *
   * Pinned in the drawer's header row rather than filed inside a section,
   * because TONE3000 require a **persistent** path to the full catalogue from
   * anywhere their tones appear — a heading the user can collapse is not
   * that. Laid out as one horizontal strip so it shares the row with the
   * filter and the scan button instead of holding a band of its own.
   *
   * It carries the full logo: this is an entry point, and the compact T3K mark
   * is only used once the full one has been seen (see Tone3000Logo).
   */
  interface Props {
    onOpen: () => void;
    /** The installed Neural Amp Modeler. Without it there is no module a drop
        could create, so the tile stops being draggable and only opens the
        browser — which installs the plugin first and then goes on to TONE3000
        by itself (see `browseTone3000` in App.svelte). */
    namPluginId?: string;
    onDragStart?: (payload: { pluginId: string; tone3000: true }) => void;
    onDragEnd?: () => void;
    /** Flash the tile — the drawer's reveal, asked for by the empty rack when
        it is clicked. Same pulse a freshly installed package's tile gets. */
    revealed?: boolean;
  }

  let { onOpen, namPluginId, onDragStart, onDragEnd, revealed = false }: Props = $props();

  const draggable = $derived(namPluginId !== undefined);

  function startDrag(e: DragEvent) {
    if (!draggable || namPluginId === undefined || !e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'copy';
    // The same custom type a patch tile uses, so only rack drop zones will
    // take it; `tone3000` is what tells the rack to open the browser instead
    // of inserting something it does not have yet.
    const payload = { pluginId: namPluginId, tone3000: true } as const;
    e.dataTransfer.setData('application/x-plectrify-new-module', JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', 'TONE3000');
    onDragStart?.(payload);
  }
</script>

<button
  type="button"
  class={[
    't3k-tile group flex min-w-0 items-center gap-2 rounded-lg border border-[color:var(--chrome-control-border)] bg-panel py-[.3rem] pr-3 pl-1.5 text-left shadow-[var(--chrome-control-shadow)] transition-colors hover:border-accent/60 hover:bg-control-hover',
    draggable ? 'cursor-grab' : 'cursor-pointer',
    revealed && 'animate-reveal-pulse',
  ]}
  {draggable}
  ondragstart={startDrag}
  ondragend={onDragEnd}
  onclick={onOpen}
  {@attach tooltip(
    draggable
      ? 'Drag onto a gap to place a tone, onto an amp capture to swap its tone, or click to browse'
      : 'Browse amp captures and IRs on TONE3000',
  )}
>
  <!-- The grip is the tile's one claim that it is dragged rather than merely
       pressed — the same language the drawer's hint and the module card's
       grab strip use — and it is the part that disappears when there is no
       plugin to build a module from, leaving an ordinary button. -->
  {#if draggable}
    <DotsSixVerticalIcon
      size={15}
      weight="bold"
      class="flex-none text-muted opacity-60 transition-opacity group-hover:opacity-100"
      aria-hidden="true"
    />
  {:else}
    <span class="w-1 flex-none" aria-hidden="true"></span>
  {/if}
  <Tone3000Logo height={15} />
  <span class="min-w-0 truncate text-[length:var(--drawer-font-title,.8rem)] text-ink/80">
    Amp captures &amp; IRs
  </span>
</button>

<style>
  /* Light: the tile sits white-on-white against the drawer's near-white
     chrome, so it takes a panel a step below it — same value as the light
     blocks in PatchTile and the drawer's plugin chips. */
  :global(:root[data-theme='light']) .t3k-tile {
    --color-panel: rgb(238 242 247 / 0.94);
  }
  /* Drag-ghost fix, same as PatchTile: Chromium snapshots a dragged element
     without isolating it from its parent, so the chrome behind the rounded
     corners rides into the ghost as opaque squares. A no-op transform gives
     the tile its own paint layer and the ghost keeps its transparency. */
  .t3k-tile {
    transform: translate(0, 0);
  }
</style>

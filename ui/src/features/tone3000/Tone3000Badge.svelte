<script lang="ts">
  import type { Tone3000Provenance } from '../../lib/engine/tone3000';
  import { formatLabel, gearLabel } from '../../lib/engine/tone3000';
  import Tone3000Logo from './Tone3000Logo.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';

  /**
   * The origin marker on anything carrying a TONE3000 tone: a module card, a
   * patch tile, a row in the patch menu.
   *
   * TONE3000's requirements ask that a loaded tone show the tone image and the
   * T3K mark in its block, and — where space allows — the title, gear type,
   * format and creator. `size` is how much of that fits: the same facts at four
   * densities, so the places it appears cannot drift apart.
   *
   * `credit` is the odd one and exists for the module card, which shows the
   * tone's picture at a readable size and carries the mark in its title bar
   * already. What is left for the badge there is the part nothing else says —
   * who made this — and the missing-capture chip. Repeating the mark and the
   * picture beside them would be noise, not attribution.
   *
   * Attribution is the point, not decoration. The creator's name rides along
   * wherever there is room, and the mark links to the tone's own page.
   */
  interface Props {
    provenance: Tone3000Provenance;
    /** 'inline' is the mark alone; 'compact' adds gear and format; 'full' adds
        the artwork and the creator; 'credit' is the creator alone. */
    size?: 'inline' | 'compact' | 'full' | 'credit';
    /** The capture this patch names is not on disk — recorded here rather than
        derived, because only the engine knows what is actually there. */
    missing?: boolean;
    /** Open the tone's TONE3000 page. Absent makes the mark inert, which is
        what a drag-only tile wants. */
    onOpen?: () => void;
    onRepair?: () => void;
  }

  let { provenance, size = 'compact', missing = false, onOpen, onRepair }: Props = $props();

  const gear = $derived(gearLabel(provenance.gear));
  const format = $derived(formatLabel(provenance.format));
  const credit = $derived(
    [provenance.creator.username && `Tone by @${provenance.creator.username}`, provenance.license]
      .filter(Boolean)
      .join(' · '),
  );
</script>

<div class="flex min-w-0 items-center gap-1.5">
  {#if size === 'full' && provenance.imageUrl}
    <!-- No crossOrigin: this is a plain image load, and asking for CORS would
         make it fail the moment a CDN response lacks the header. -->
    <img
      src={provenance.imageUrl}
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      class="size-6 shrink-0 rounded object-cover"
    />
  {/if}

  {#if size !== 'credit'}
    {#if onOpen}
      <button
        type="button"
        class="shrink-0 cursor-pointer opacity-90 hover:opacity-100"
        onclick={onOpen}
        aria-label="View “{provenance.title}” on TONE3000"
        {@attach tooltip(credit ? `${credit} — open on TONE3000` : 'Open on TONE3000')}
      >
        <Tone3000Logo variant="mark" height={12} />
      </button>
    {:else}
      <span class="shrink-0 opacity-90" {@attach tooltip(credit)}>
        <Tone3000Logo variant="mark" height={12} />
      </span>
    {/if}
  {/if}

  {#if size === 'compact' || size === 'full'}
    <!-- The size rides the drawer's type scale when rendered inside it; the
         fallback keeps the badge's own size everywhere else (module card,
         patch menu), which must not grow with the drawer. -->
    <span class="min-w-0 truncate text-[length:var(--drawer-font-label,.65rem)] text-muted">
      {gear} · {format}
    </span>
  {/if}

  {#if (size === 'full' || size === 'credit') && provenance.creator.username}
    <span class="min-w-0 truncate text-[length:var(--drawer-font-label,.65rem)] text-muted"
      >@{provenance.creator.username}</span
    >
  {/if}

  {#if missing}
    <!-- Quiet rather than modal. A rig recalled on a fresh machine should not
         stop the show; the chip says what is wrong and offers the one action
         that fixes it. -->
    <button
      type="button"
      class="shrink-0 cursor-pointer rounded bg-warn/15 px-1 py-px text-[length:var(--drawer-font-label,.6rem)] text-warn hover:bg-warn/25"
      onclick={onRepair}
      {@attach tooltip('The capture file is missing — download it again')}
    >
      Capture missing
    </button>
  {/if}
</div>

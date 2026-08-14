<script lang="ts">
  import Knob from './Knob.svelte';

  /**
   * The hero's centrepiece: a three-module rack, drawn from the same tokens the
   * real module cards use — panel surface, hairline edge, per-module accent
   * tint, mono labels.
   *
   * It is a *picture*, not a live rack. Every value is fixed and nothing
   * responds to a drag. That is the honest thing for a landing page to be: an
   * interactive facsimile teaches the reader gestures the real app may not
   * share, and invites them to judge the product by a mock-up of it.
   *
   * The chain runs left → right on a wide screen and top → bottom on a phone,
   * which is the one thing about the layout that has to survive the breakpoint —
   * "signal flows one way through a row of pedals" is the whole idea.
   *
   * Which is also why the connectors are drawn in the accent and the row closes
   * to a zero gap at `lg`: the leads run edge to edge between the cards, so the
   * picture reads as one patched chain rather than as three cards with arrows
   * floating between them. The lead is the second-brightest thing here after
   * the module names, because it is the second thing the reader has to
   * understand.
   */
  interface Module {
    name: string;
    role: string;
    accent: string;
    knobs: { label: string; value: number }[];
  }

  const modules: Module[] = [
    {
      name: 'Screamer',
      role: 'Overdrive',
      accent: '#ffb000',
      knobs: [
        { label: 'Drive', value: 0.62 },
        { label: 'Tone', value: 0.48 },
        { label: 'Level', value: 0.7 },
      ],
    },
    {
      name: 'Plexi 45',
      role: 'Amp sim',
      accent: '#00ffcc',
      knobs: [
        { label: 'Gain', value: 0.74 },
        { label: 'Bass', value: 0.5 },
        { label: 'Mid', value: 0.66 },
        { label: 'Treble', value: 0.58 },
      ],
    },
    {
      name: 'Chamber',
      role: 'Reverb',
      accent: '#8b7cff',
      knobs: [
        { label: 'Mix', value: 0.28 },
        { label: 'Decay', value: 0.44 },
      ],
    },
  ];
</script>

<!-- aria-hidden: the diagram restates the paragraph beside it, and spelling out
     eleven knob values to a screen reader is noise, not information. -->
{#snippet lead()}
  <!-- The patch lead into the next thing along. A quarter turn on narrow
       screens, where the chain stacks top to bottom. -->
  <div class="flex shrink-0 items-center justify-center lg:w-11">
    <svg
      class="h-3 w-11 rotate-90 lg:rotate-0"
      viewBox="0 0 44 12"
      fill="none"
      stroke="color-mix(in srgb, var(--color-accent) 40%, transparent)"
      stroke-width="1.4"
    >
      <!-- Both ends run to the edge of the box, which the zero gap at `lg` puts
           flush against the cards either side. A lead that stops short of the
           socket is a lead that is not plugged in. -->
      <path d="M0 6h43" />
      <path d="m39 2 4 4-4 4" stroke-linejoin="round" />
    </svg>
  </div>
{/snippet}

<div
  class="flex flex-col items-center gap-3 lg:flex-row lg:items-stretch lg:justify-center lg:gap-0"
  aria-hidden="true"
>
  <!-- Input terminal -->
  <div class="flex items-center justify-center lg:flex-col">
    <span
      class="rounded-control-sm text-control-body border border-[color:var(--edge)] bg-[var(--color-well)] px-3.5 py-2.5 font-mono text-[0.6rem] font-semibold tracking-[0.14em] uppercase"
    >
      Guitar in
    </span>
  </div>

  {#each modules as module, i (module.name)}
    {@render lead()}

    <div
      class="surface relative w-full max-w-[19rem] overflow-hidden p-5 lg:w-auto"
      style="--knob-accent: {module.accent}"
    >
      <!-- The accent bar along the card's top edge, exactly as a tinted module
           card carries it in the app. -->
      <div
        class="absolute inset-x-0 top-0 h-px"
        style="background: linear-gradient(90deg, transparent, {module.accent}, transparent)"
      ></div>

      <div class="mb-4 flex items-baseline justify-between gap-4">
        <span class="text-ink text-base font-semibold tracking-tight">{module.name}</span>
        <span
          class="font-mono text-[0.55rem] font-semibold tracking-[0.14em] uppercase"
          style="color: {module.accent}"
        >
          {module.role}
        </span>
      </div>

      <div class="flex items-start justify-center gap-5">
        {#each module.knobs as knob (knob.label)}
          <Knob label={knob.label} value={knob.value} size={52} />
        {/each}
      </div>

      <div
        class="text-control-off mt-4 flex items-center gap-1.5 border-t border-[color:var(--edge-hair)] pt-3 font-mono text-[0.55rem] tracking-[0.1em] uppercase"
      >
        <span class="size-1.5 rounded-full" style="background: {module.accent}"></span>
        Slot {i + 1}
      </div>
    </div>
  {/each}

  {@render lead()}

  <div class="flex items-center justify-center lg:flex-col">
    <span
      class="rounded-control-sm text-accent border border-[color:color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-3.5 py-2.5 font-mono text-[0.6rem] font-semibold tracking-[0.14em] uppercase"
    >
      Out
    </span>
  </div>
</div>

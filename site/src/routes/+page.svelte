<script lang="ts">
  import { DESCRIPTION, IDENTITY, PRODUCT, TAGLINE, VIDEO } from '$lib/site';
  import DownloadButtons from '$lib/components/DownloadButtons.svelte';
  import VideoEmbed from '$lib/components/VideoEmbed.svelte';
  import Knob from '$lib/components/Knob.svelte';
  import tone3000Logo from '$lib/assets/tone3000-logo.svg';
  import screenshotRack from '$lib/assets/screenshot-rack.png';

  /* Six cards, one point each, one sentence each. Ordered by what a guitarist
     needs answered: what it feels like to play (latency), what to play through
     (plugins, captures), then what the host itself adds. Everything here must
     be literally true of the shipping app: "amps included" was cut when the
     starter amps stopped being bundled.

     Each card leads with a vignette rather than an icon. A stroke icon from a
     general-purpose set says "feature card" and nothing about this product; a
     fragment of the rack drawn in the app's own idiom (mono readouts, module
     chips, knobs, lanes) says what the card is about before the title is read,
     and it could only belong to this page. `art` names the snippet below that
     draws it. The TONE3000 card carries their wordmark instead. The artwork is
     their trademark, reproduced verbatim (this dark page is the ground it was
     drawn for), and this is its first appearance on the site, which their
     integration rules require to be the full logo rather than the compact T3K
     mark. */
  type Art = 'latency' | 'chain' | 'tone3000' | 'split' | 'knobs' | 'rigs';
  const features: { title: string; body: string; art: Art }[] = [
    {
      title: 'Low latency',
      body: 'ASIO on Windows, CoreAudio on macOS, JACK or PipeWire on Linux. Plug in and play in real time.',
      art: 'latency',
    },
    {
      title: 'Your plugins, any order',
      body: 'Runs your own VST3 amps and effects, from any maker, in any chain you like.',
      art: 'chain',
    },
    {
      title: 'Thousands of amp captures',
      body: 'Load a capture of a real amp from the TONE3000 library, right inside the app.',
      art: 'tone3000',
    },
    {
      title: 'Two amps at once',
      body: 'Split the chain into parallel paths, each with its own volume, pan, mute and solo.',
      art: 'split',
    },
    {
      title: 'Only the controls you use',
      body: 'Map the few knobs you actually reach for, and hide the rest of the plugin.',
      art: 'knobs',
    },
    {
      title: 'Save and recall',
      body: 'Save rigs and patches, load them any time. Your last session restores on launch.',
      art: 'rigs',
    },
  ];

  /* The two occasions the app is opened for. Kept out of the feature grid and
     given a section of its own, because "can I practise with this" and "can I
     gig with this" are questions a card in the feature grid does not answer
     convincingly. Every item listed ships in the sidebar today; see
     ui/src/features/. Text only, unlike the feature cards: vignettes (a
     metronome, the Perform switch) and player pictograms were both tried here
     and dropped, since an occasion is not a thing to draw a still of. */
  const occasions: {
    title: string;
    body: string;
    items: string[];
  }[] = [
    {
      title: 'At home',
      body: 'Tune up, set a tempo and loop a passage until you have it, all without leaving your rig.',
      items: ['Tuner', 'Metronome with tap tempo', 'Looper'],
    },
    {
      title: 'On stage',
      body:
        'Put your songs in a setlist, and each one loads its rig. Step through the set with a ' +
        'MIDI footswitch.',
      items: ['Songs and setlists', 'Scenes', 'MIDI learn'],
    },
  ];
</script>

<svelte:head>
  <title>{PRODUCT} · {TAGLINE}</title>
  <meta name="description" content={DESCRIPTION} />
  <meta property="og:title" content="{PRODUCT} · {TAGLINE}" />
  <meta property="og:description" content={DESCRIPTION} />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<!-- ── Hero ─────────────────────────────────────────────────────────────── -->
<section class="relative overflow-hidden px-5 pt-20 pb-14 sm:px-8 sm:pt-28">
  <div class="mx-auto max-w-3xl text-center">
    <h1 class="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
      Your pedalboard,<br class="hidden sm:inline" />
      <span class="text-accent text-shadow-(--text-shadow-glow-accent)">without the DAW.</span>
    </h1>
    <!-- The TONE3000 sentence lives here rather than in site.ts because it ends
         in their wordmark, which is markup. First appearance of the mark on the
         page, so it is the full logo, per their integration rules. -->
    <p class="text-ink mx-auto mt-6 max-w-xl text-lg font-medium text-balance sm:text-xl">
      {IDENTITY}<br />
      Thousands of amp captures from
      <img
        src={tone3000Logo}
        alt="TONE3000"
        class="inline-block h-[1em] w-auto translate-y-[0.02em] select-none"
      />
    </p>
    <div class="mt-10">
      <DownloadButtons />
    </div>
    <!-- The "…but I don't own any plugins" objection is deliberately *not*
         answered here. It is a real objection, but it is the fourth thing said
         under one button, and the hero was ending in a tail of small grey lines
         that each asked to be read. The TONE3000 feature card answers it a
         screen further down. -->
  </div>

  <!-- The hero shot is the real app, which is why it replaced the drawn
       three-module facsimile that stood here: the product's whole claim is
       that it looks like a pedalboard, and a picture of the thing itself makes
       that claim in a way a diagram built from the same tokens never could.
       Framed so it sits on the page rather than floating as a bare rectangle,
       but deliberately *not* in .surface — the one place on this page that
       idiom does not fit. A card is translucent (panel at 85%, over a blurred
       backdrop) and carries its hairline as a real border, which is right when
       the fill is a wash the page is meant to show through and wrong under an
       opaque screenshot: the page came through the border ring and through all
       four corners, where the image's square edge is clipped off by the radius.

       So the fill is the solid panel token, and the hairline is drawn *inward*
       over the image by an overlay clipped to the same radius. Being inset, it
       has the screenshot behind it instead of the page, leaving nothing to see
       through, and it still reads as the lit edge of a panel.

       Eager and high priority, with its intrinsic size declared: this is the
       page's largest element and its LCP, so it must neither be deferred nor
       reflow the section once it lands. -->
  <div class="mx-auto mt-16 max-w-6xl sm:mt-20">
    <div class="rounded-control-lg bg-panel-solid relative overflow-hidden shadow-(--shadow-panel)">
      <img
        src={screenshotRack}
        alt="The Plectrify rack: a chorus and an overdrive feeding three parallel amp lanes, then a reverb, each module showing only its mapped knobs"
        width="2096"
        height="1323"
        fetchpriority="high"
        class="block h-auto w-full"
      />
      <div
        class="rounded-control-lg pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-ink)_14%,transparent)]"
        aria-hidden="true"
      ></div>
    </div>
  </div>
</section>

<!-- The "what it isn't" strip lived here: three mono negatives in a ruled band
     between the hero and the features. It said what the product is not before
     the page had finished saying what it is, and no account / no DRM / no
     telemetry is a promise, not a headline. The download section makes the free
     and open-source claim where it matters, at the point of clicking. -->

<!-- ── Features ─────────────────────────────────────────────────────────── -->
<section id="features" class="scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24">
  <div class="mx-auto max-w-6xl">
    <div class="max-w-2xl">
      <h2 class="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Features</h2>
    </div>

    <div class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each features as feature (feature.title)}
        <article class="surface surface-hover p-6">
          <!-- One fixed-height vignette row on every card, so titles and bodies
               align across the grid whatever the slot holds. Decorative: every
               vignette restates its card's title, so it is hidden from
               assistive tech rather than described twice. -->
          <div class="flex h-16 items-center" aria-hidden="true">
            {#if feature.art === 'latency'}
              {@render latency()}
            {:else if feature.art === 'chain'}
              {@render chain()}
            {:else if feature.art === 'tone3000'}
              <img src={tone3000Logo} alt="" class="h-[1.1rem] w-auto select-none" />
            {:else if feature.art === 'split'}
              {@render split()}
            {:else if feature.art === 'knobs'}
              {@render knobs()}
            {:else}
              {@render rigs()}
            {/if}
          </div>
          <h3 class="text-ink mt-4 text-[1.05rem] font-semibold tracking-tight">{feature.title}</h3>
          <p class="text-muted mt-2.5 text-[0.9rem] leading-relaxed">{feature.body}</p>
        </article>
      {/each}
    </div>
  </div>
</section>

<!-- ── Feature vignettes ────────────────────────────────────────────────────
     Each is a still of one corner of the rack, in the app's own tokens. Static
     on purpose, like the Knob: the page is a picture of the product, not a copy
     of it. -->

<!-- The status bar's readout. 64 samples at 48 kHz is 1.3 ms, so the number is
     arithmetic rather than a benchmark; the rate is left off, since it is the
     buffer a guitarist reads. -->
{#snippet latency()}
  <div class="flex items-baseline gap-3">
    <span
      class="text-accent font-mono text-2xl font-semibold tabular-nums text-shadow-(--text-shadow-glow-accent-sm)"
    >
      1.3<span class="ml-1 text-sm">ms</span>
    </span>
    <span class="text-control-quiet font-mono text-[0.62rem] tracking-[0.08em] uppercase">
      64 samples
    </span>
  </div>
{/snippet}

<!-- Three modules in a chain, the middle one lifted mid-drag. -->
{#snippet chain()}
  <div class="flex items-center">
    {@render chip('Drive')}
    {@render wire()}
    <span
      class="rounded-control-xs border-accent text-accent -translate-y-1.5 rotate-[-3deg] border bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-2.5 py-1 font-mono text-[0.62rem] font-semibold tracking-[0.08em] uppercase shadow-(--shadow-glow-accent-sm)"
    >
      Amp
    </span>
    {@render wire()}
    {@render chip('Reverb')}
  </div>
{/snippet}

<!-- One input fanning into two lanes and summing again: the docs' signal-flow
     diagram, drawn instead of typed. -->
{#snippet split()}
  <div class="flex items-center">
    <svg
      width="34"
      height="56"
      viewBox="0 0 34 56"
      fill="none"
      stroke="var(--edge-hover)"
      stroke-width="1.25"
    >
      <path d="M0 28 H10 C18 28 18 12 26 12 H34" />
      <path d="M10 28 C18 28 18 44 26 44 H34" />
    </svg>
    <div class="flex flex-col gap-2">
      {@render chip('Amp A')}
      {@render chip('Amp B')}
    </div>
    <svg
      width="34"
      height="56"
      viewBox="0 0 34 56"
      fill="none"
      stroke="var(--edge-hover)"
      stroke-width="1.25"
    >
      <path d="M0 12 H8 C16 12 16 28 24 28 H34" />
      <path d="M0 44 H8 C16 44 16 28 24 28" />
    </svg>
  </div>
{/snippet}

<!-- Two mapped knobs: the whole module card, as far as the player is concerned. -->
{#snippet knobs()}
  <div class="flex items-end gap-4">
    <Knob label="Gain" value={0.68} size={40} />
    <Knob label="Tone" value={0.42} size={40} />
  </div>
{/snippet}

<!-- The rig list, one row selected. -->
{#snippet rigs()}
  <ul class="flex w-full max-w-[13rem] flex-col gap-1 font-mono text-[0.68rem] tracking-[0.04em]">
    <li
      class="rounded-control-xs text-ink flex items-center gap-2 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-2 py-1"
    >
      <span class="bg-accent size-1.5 rounded-full shadow-(--shadow-glow-accent-sm)"></span>
      Clean Twin
    </li>
    <li class="text-control-quiet flex items-center gap-2 px-2 py-0.5">
      <span class="border-control-edge size-1.5 rounded-full border"></span>
      Doom Stack
    </li>
  </ul>
{/snippet}

{#snippet chip(label: string)}
  <span
    class="rounded-control-xs border-control-edge text-control-body border bg-[var(--fill-rest)] px-2.5 py-1 font-mono text-[0.62rem] font-semibold tracking-[0.08em] uppercase"
  >
    {label}
  </span>
{/snippet}

{#snippet wire()}
  <span class="bg-control-edge-hover h-px w-3"></span>
{/snippet}

<!-- ── Practice and stage ───────────────────────────────────────────────── -->
<section id="practice" class="scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24">
  <div class="mx-auto max-w-6xl">
    <div class="max-w-2xl">
      <h2 class="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Practice and performance
      </h2>
    </div>

    <div class="mt-8 grid gap-4 lg:grid-cols-2">
      {#each occasions as occasion (occasion.title)}
        <article class="surface surface-hover flex flex-col p-7">
          <h3 class="text-ink text-xl font-semibold tracking-tight text-balance">
            {occasion.title}
          </h3>
          <p class="text-muted mt-3 leading-relaxed text-pretty">{occasion.body}</p>
          <ul class="mt-6 flex flex-wrap gap-2">
            {#each occasion.items as item (item)}
              <li
                class="rounded-control-xs border-control-edge-soft text-control-quiet border px-2.5 py-1 font-mono text-[0.62rem] tracking-[0.08em] uppercase"
              >
                {item}
              </li>
            {/each}
          </ul>
        </article>
      {/each}
    </div>
  </div>
</section>

<!-- ── Demo video ───────────────────────────────────────────────────────────
     Heading left-aligned, like every other section heading on the page. The
     centred CTA below is the one exception, and it earns it by being a panel
     the reader is meant to act on rather than a section they read past. -->
<section id="video" class="scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24">
  <!-- max-w-6xl, the same column as Features and Practice. A narrower wrapper
       would set this heading in from theirs, which is worse than the centring
       it replaced: an inconsistent left edge reads as a mistake where a centred
       block reads as a choice. -->
  <div class="mx-auto max-w-6xl">
    <div class="mb-6 max-w-2xl">
      <h2 class="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Demo</h2>
    </div>
    <VideoEmbed id={VIDEO.youtubeId} title={VIDEO.title} />
  </div>
</section>

<!-- ── Download ─────────────────────────────────────────────────────────────
     A panel in the rack-module idiom rather than a centred card floating apart
     from the page: the same max-w-6xl column and left-aligned eyebrow + heading
     as every section above it, the accent hairline a tinted module card wears
     along its top edge (always on here: this is the one card the reader is
     meant to act on), and the module card's ruled mono footer for the
     getting-started line. The buttons sit as a second column on desktop, so the
     panel reads heading → promise → action left to right instead of a tall
     centred stack of small lines under one button. -->
<section id="download" class="scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24">
  <div class="mx-auto max-w-6xl">
    <div class="surface relative overflow-hidden shadow-(--shadow-glow-accent-lg)">
      <div
        class="absolute inset-x-0 top-0 h-px"
        style="background: linear-gradient(90deg, transparent, var(--color-accent), transparent)"
        aria-hidden="true"
      ></div>

      <div class="grid gap-10 p-7 sm:p-12 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-16">
        <div class="max-w-xl">
          <h2 class="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Download</h2>
          <p class="text-muted mt-4 leading-relaxed text-pretty">
            {PRODUCT} is free, now and for every future release. Bring your own VST3 plugins, or play
            amp captures from TONE3000.
          </p>
          <!-- The old "what it isn't" strip's promises, kept at the point of
               clicking (where a promise is checked), in the same mono chips
               the practice/stage cards use. -->
          <ul class="mt-7 flex flex-wrap gap-2">
            {#each ['No account', 'No telemetry', 'No paid tier'] as promise (promise)}
              <li
                class="rounded-control-xs border-control-edge-soft text-control-quiet border px-2.5 py-1 font-mono text-[0.62rem] tracking-[0.08em] uppercase"
              >
                {promise}
              </li>
            {/each}
          </ul>
        </div>

        <div class="lg:px-4">
          <DownloadButtons />
        </div>
      </div>

      <div class="border-control-edge-hair border-t px-7 py-4 sm:px-12">
        <p class="text-muted flex items-center gap-2.5 text-sm">
          <span class="bg-accent size-1.5 shrink-0 rounded-full" aria-hidden="true"></span>
          <span>
            New to it? The <a href="/docs/getting-started" class="text-accent hover:underline">
              getting-started guide
            </a> takes about five minutes.
          </span>
        </p>
      </div>
    </div>
  </div>
</section>

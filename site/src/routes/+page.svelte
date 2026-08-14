<script lang="ts">
  import { DESCRIPTION, IDENTITY, LEAD, PRODUCT, TAGLINE, VIDEO } from '$lib/site';
  import RackDiagram from '$lib/components/RackDiagram.svelte';
  import DownloadButtons from '$lib/components/DownloadButtons.svelte';
  import VideoEmbed from '$lib/components/VideoEmbed.svelte';
  import tone3000Logo from '$lib/assets/tone3000-logo.svg';

  /* Six cards, one point each, one sentence each. Ordered by what a guitarist
     needs answered: what it feels like to play (latency), what to play through
     (plugins, captures), then what the host itself adds. Everything here must
     be literally true of the shipping app — "amps included" was cut when the
     starter amps stopped being bundled.

     Each card leads with an icon so the grid scans without reading. The icons
     are lucide.dev strokes (ISC licence), inlined so the page stays
     self-contained; `icon` is the inner markup of a 24×24 stroke SVG. The
     TONE3000 card carries their wordmark instead — the artwork is their
     trademark, reproduced verbatim (this dark page is the ground it was drawn
     for), and this is its first appearance on the site, which their integration
     rules require to be the full logo rather than the compact T3K mark. */
  const features: { title: string; body: string; icon?: string }[] = [
    {
      title: 'Low latency',
      body: 'ASIO on Windows, CoreAudio on macOS. Plug in and play in real time.',
      icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />',
    },
    {
      title: 'Your plugins, any order',
      body: 'Runs your own VST3 amps and effects, from any maker, in any chain you like.',
      icon: '<rect width="7" height="7" x="14" y="3" rx="1" /><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" />',
    },
    {
      title: 'Thousands of amp captures',
      body: 'Load a capture of a real amp from the TONE3000 library, right inside the app.',
    },
    {
      title: 'Two amps at once',
      body: 'Split the chain into parallel paths, each with its own volume, pan, mute and solo.',
      icon: '<path d="M16 3h5v5" /><path d="M8 3H3v5" /><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" /><path d="m15 9 6-6" />',
    },
    {
      title: 'Only the controls you use',
      body: 'Map the few knobs you actually reach for, and hide the rest of the plugin.',
      icon: '<line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" />',
    },
    {
      title: 'Save and recall',
      body: 'Save rigs and patches, load them any time. Your last session restores on launch.',
      icon: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" />',
    },
  ];

  /* The two occasions the app is opened for. Kept out of the feature grid and
     given a section of its own, because "can I practise with this" and "can I
     gig with this" are questions a card in the feature grid does not answer
     convincingly. Every item listed ships in the sidebar today — see
     ui/src/features/. */
  const occasions = [
    {
      kicker: 'At home',
      title: 'Everything you need to practice',
      body: 'Tune up, set a tempo and loop a passage until you have it, all without leaving your rig.',
      items: ['Tuner', 'Metronome with tap tempo', 'Looper'],
    },
    {
      kicker: 'On stage',
      title: 'Ready to play live',
      body:
        'Put your songs in a setlist, and each one loads its rig. Step through the set with a ' +
        'MIDI footswitch.',
      items: ['Songs and setlists', 'Scenes', 'MIDI learn', 'Stage view'],
    },
  ];
</script>

<svelte:head>
  <title>{PRODUCT} — {TAGLINE}</title>
  <meta name="description" content={DESCRIPTION} />
  <meta property="og:title" content="{PRODUCT} — {TAGLINE}" />
  <meta property="og:description" content={DESCRIPTION} />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<!-- ── Hero ─────────────────────────────────────────────────────────────── -->
<section class="relative overflow-hidden px-5 pt-20 pb-14 sm:px-8 sm:pt-28">
  <div class="mx-auto max-w-3xl text-center">
    <p class="eyebrow">For guitarists · Practice and stage</p>
    <h1 class="mt-5 text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
      Your pedalboard,<br class="hidden sm:inline" />
      <span class="text-accent [text-shadow:var(--text-shadow-glow-accent)]">without the DAW.</span>
    </h1>
    <!-- Identity then experience. The two carry different weights on purpose:
         this line is nearly body-bright so it is read, the paragraph under it
         recedes to --color-muted so the pair does not compete with the
         headline. They also narrow as they descend — headline, then identity,
         then lead — so three centred blocks read as one tapering shape rather
         than as three paragraphs of the same width and nearly the same size. -->
    <!-- The TONE3000 sentence lives here rather than in site.ts because it ends
         in their wordmark, which is markup. First appearance of the mark on the
         page, so it is the full logo, per their integration rules. -->
    <p class="text-ink mx-auto mt-6 max-w-xl text-lg font-medium text-balance sm:text-xl">
      {IDENTITY}
      Plays thousands of real amp captures from
      <img
        src={tone3000Logo}
        alt="TONE3000"
        class="inline-block h-[1em] w-auto translate-y-[0.02em] select-none"
      />
    </p>
    <p class="text-muted mx-auto mt-4 max-w-lg leading-relaxed text-pretty">
      {LEAD}
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

  <div class="mx-auto mt-16 max-w-6xl sm:mt-20">
    <RackDiagram />
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
      <p class="eyebrow">Features</p>
      <h2 class="mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        A pedalboard on your screen.
      </h2>
    </div>

    <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each features as feature (feature.title)}
        <article class="surface surface-hover p-6">
          <!-- One fixed-height icon row on every card, so titles and bodies
               align across the grid whether the slot holds a 24 px icon or the
               wider TONE3000 wordmark. -->
          <div class="flex h-9 items-center" aria-hidden="true">
            {#if feature.icon}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="text-accent size-6"
              >
                {@html feature.icon}
              </svg>
            {:else}
              <img src={tone3000Logo} alt="TONE3000" class="h-[1.1rem] w-auto select-none" />
            {/if}
          </div>
          <h3 class="text-ink mt-4 text-[1.05rem] font-semibold tracking-tight">{feature.title}</h3>
          <p class="text-muted mt-2.5 text-[0.9rem] leading-relaxed">{feature.body}</p>
        </article>
      {/each}
    </div>
  </div>
</section>

<!-- ── Practice and stage ───────────────────────────────────────────────── -->
<section id="practice" class="scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24">
  <div class="mx-auto max-w-6xl">
    <div class="max-w-2xl">
      <p class="eyebrow">Practice and performance</p>
      <h2 class="mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        One rig, from bedroom to stage.
      </h2>
    </div>

    <div class="mt-12 grid gap-4 lg:grid-cols-2">
      {#each occasions as occasion (occasion.kicker)}
        <article class="surface surface-hover flex flex-col p-7">
          <p class="eyebrow">{occasion.kicker}</p>
          <h3 class="text-ink mt-3.5 text-xl font-semibold tracking-tight text-balance">
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
    <div class="mb-10 max-w-2xl">
      <p class="eyebrow">Demo</p>
      <h2 class="mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Watch it work.
      </h2>
    </div>
    <VideoEmbed id={VIDEO.youtubeId} title={VIDEO.title} />
  </div>
</section>

<!-- ── Download ─────────────────────────────────────────────────────────────
     A panel in the rack-module idiom rather than a centred card floating apart
     from the page: the same max-w-6xl column and left-aligned eyebrow + heading
     as every section above it, the accent hairline a tinted module card wears
     along its top edge (always on here — this is the one card the reader is
     meant to act on), and the module card's ruled mono footer for the
     getting-started line. The buttons sit as a second column on desktop, so the
     panel reads heading → promise → action left to right instead of a tall
     centred stack of small lines under one button. -->
<section id="download" class="scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24">
  <div class="mx-auto max-w-6xl">
    <div class="surface relative overflow-hidden shadow-[var(--shadow-glow-accent-lg)]">
      <div
        class="absolute inset-x-0 top-0 h-px"
        style="background: linear-gradient(90deg, transparent, var(--color-accent), transparent)"
        aria-hidden="true"
      ></div>

      <div class="grid gap-10 p-7 sm:p-12 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-16">
        <div class="max-w-xl">
          <p class="eyebrow">Download</p>
          <h2 class="mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Free, open source, and yours to keep.
          </h2>
          <p class="text-muted mt-4 leading-relaxed text-pretty">
            {PRODUCT} is free, now and for every future release. Bring your own VST3 plugins, or play
            amp captures from TONE3000.
          </p>
          <!-- The old "what it isn't" strip's promises, kept at the point of
               clicking — where a promise is checked — in the same mono chips
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

      <div class="border-t border-[color:var(--edge-hair)] px-7 py-4 sm:px-12">
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

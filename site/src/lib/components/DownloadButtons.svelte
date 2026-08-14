<script lang="ts">
  import { DOWNLOADS, RELEASES_URL } from '$lib/site';

  /**
   * Both platforms, always both shown — but the one that will actually run on
   * this machine leads.
   *
   * The ranking is done in CSS off `<html data-os>`, which the inline probe in
   * app.html stamps before first paint. It cannot be done in component code:
   * every page is prerendered, so the server has no idea what OS is asking, and
   * promoting a button after hydration would re-rank them a beat after the page
   * appears — the reader would watch the buttons change under the cursor.
   *
   * Three states, and the third is the point:
   *
   *   windows  — the Windows build is the filled accent button, macOS is quiet
   *   macos    — the mirror image
   *   unknown  — both keep equal weight
   *
   * "Unknown" is not a failure case to be papered over. A phone, a tablet or a
   * Linux box gets it, and a reader on a phone is choosing what to install on a
   * machine that is somewhere else — exactly the case a guess gets wrong. The
   * demoted button is also never *dimmed*: it keeps a full border and body-weight
   * text, because someone downloading for their other machine must not be told
   * the build they want is unavailable.
   */
  interface Props {
    /** `hero` is the landing page's pair; `compact` is the footer's. */
    size?: 'hero' | 'compact';
  }

  let { size = 'hero' }: Props = $props();
</script>

<div class="wrap">
  <div class="row">
    {#each DOWNLOADS as dl (dl.os)}
      <a href={dl.url} class="dl" class:compact={size === 'compact'} data-platform={dl.platform}>
        {#if dl.platform === 'windows'}
          <svg class="glyph" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path
              d="M3 5.6 10.2 4.6v6.9H3V5.6Zm0 12.8 7.2 1v-6.8H3v5.8Zm8.1 1.1L21 21V12.5h-9.9v7Zm0-15.1v7h9.9V3l-9.9 1.4Z"
            />
          </svg>
        {:else}
          <svg class="glyph" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path
              d="M16.4 12.8c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.15-2.8.85-3.5.85-.7 0-1.85-.83-3.05-.81-1.55.02-3 .9-3.8 2.3-1.63 2.83-.42 7 1.17 9.3.78 1.12 1.7 2.38 2.92 2.34 1.17-.05 1.61-.76 3.03-.76 1.42 0 1.82.76 3.05.73 1.26-.02 2.06-1.14 2.83-2.27.89-1.3 1.26-2.56 1.28-2.63-.03-.01-2.45-.94-2.48-3.73ZM14.13 5.6c.63-.77 1.06-1.83.94-2.9-.91.04-2.01.61-2.67 1.37-.59.68-1.1 1.76-.96 2.8 1.01.08 2.05-.51 2.69-1.27Z"
            />
          </svg>
        {/if}
        <span class="label">
          <span class="title">Download for {dl.os}</span>
          <span class="req">{dl.requirement}</span>
        </span>
      </a>
    {/each}
  </div>

  <!-- The macOS build is not notarized, so the first launch is refused and the
       wording macOS uses is "damaged" — a reader who meets that with no warning
       concludes the download is broken and leaves. Said here, before the click,
       it is a known one-time step instead.

       Shown to everyone *except* a detected Windows machine, using the same
       data-os hook the ranking uses: on an unknown OS — a phone, a tablet,
       Linux — the reader is very likely choosing what to install on some other
       machine, and that machine may well be the Mac. Only Windows can be ruled
       out, so only Windows is. -->
  <p class="macnote">
    <a href="/docs/opening-on-macos">macOS blocks the first launch — how to open it</a>
  </p>

  <!-- No version number. It is the one fact here that nobody needs before
       clicking — the button already points at the current release — and printing
       it turns a call to action into a changelog line. Whoever does care is
       after the release notes, which is what the link is. -->
  <p class="meta">
    Free and open source ·
    <a href={RELEASES_URL} rel="noreferrer noopener" target="_blank">all releases</a>
  </p>
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  @media (min-width: 640px) {
    .row {
      flex-direction: row;
    }
  }

  /* ── Resting state: neither platform detected, so neither leads ─────────── */
  .dl {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1.25rem;
    border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
    border-radius: var(--ctl-r-md);
    background: color-mix(in srgb, var(--color-accent) 9%, transparent);
    transition:
      var(--ctl-transition),
      box-shadow var(--ctl-dur) ease;
  }

  .dl.compact {
    padding: 0.625rem 1rem;
  }

  .dl:hover {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
    box-shadow: var(--shadow-glow-accent-sm);
  }

  .glyph {
    width: 1.25rem;
    height: 1.25rem;
    flex-shrink: 0;
    color: var(--color-accent);
  }

  .label {
    text-align: left;
  }

  .title {
    display: block;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--color-ink);
  }

  .compact .title {
    font-size: 0.875rem;
  }

  .req {
    display: block;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    color: var(--ink-quiet);
  }

  /* ── Promoted: the build that runs on this machine ──────────────────────
     A solid accent fill, and `order: -1` so it comes first in both the row and
     the stacked column. Colour alone is never the signal — the button says
     which OS it is, and it moves to the front. */
  :global(:root[data-os='windows']) .dl[data-platform='windows'],
  :global(:root[data-os='macos']) .dl[data-platform='macos'] {
    order: -1;
    border-color: var(--color-accent);
    background: var(--color-accent);
    box-shadow: var(--shadow-glow-accent-sm);
  }

  :global(:root[data-os='windows']) .dl[data-platform='windows']:hover,
  :global(:root[data-os='macos']) .dl[data-platform='macos']:hover {
    background: color-mix(in srgb, var(--color-accent) 88%, #fff);
    box-shadow: var(--shadow-glow-accent);
  }

  /* Everything sitting *on* the accent fill switches to the ink meant for it —
     black here, and defined as a token so it stays right if the accent moves. */
  :global(:root[data-os='windows']) .dl[data-platform='windows'] .glyph,
  :global(:root[data-os='macos']) .dl[data-platform='macos'] .glyph,
  :global(:root[data-os='windows']) .dl[data-platform='windows'] .title,
  :global(:root[data-os='macos']) .dl[data-platform='macos'] .title {
    color: var(--color-accent-ink);
  }

  :global(:root[data-os='windows']) .dl[data-platform='windows'] .req,
  :global(:root[data-os='macos']) .dl[data-platform='macos'] .req {
    color: color-mix(in srgb, var(--color-accent-ink) 70%, transparent);
  }

  /* ── Demoted: the other platform, reduced to a link underneath ───────────
     Once we know which build runs on this machine, the other one is a footnote
     rather than a second call to action. The pair stops being a row and becomes
     a column, and the non-matching entry drops its border, fill and padding to
     read as a plain quiet link below the button.

     It keeps its glyph, because this is still the control someone downloading
     for their *other* machine clicks — but it drops the requirement text. On the
     promoted button that line answers "will this run here"; on the demoted one it
     cannot, since the machine it describes is not the one reading, and a second
     mono chip beside a quiet link is the noisiest thing in the hero for the least
     said. The requirement still travels with the file, on the releases page.

     The transparent border rather than `border: 0` is deliberate: it holds the
     same box size, so switching states never nudges the layout. */
  :global(:root[data-os='windows']) .row,
  :global(:root[data-os='macos']) .row {
    flex-direction: column;
    align-items: center;
    gap: 0.85rem;
  }

  :global(:root[data-os='windows']) .dl[data-platform='macos'],
  :global(:root[data-os='macos']) .dl[data-platform='windows'] {
    gap: 0.45rem;
    padding: 0.15rem 0.25rem;
    border-color: transparent;
    background: none;
    box-shadow: none;
  }

  :global(:root[data-os='windows']) .dl[data-platform='macos'] .glyph,
  :global(:root[data-os='macos']) .dl[data-platform='windows'] .glyph {
    width: 0.85rem;
    height: 0.85rem;
    color: var(--ink-off);
  }

  :global(:root[data-os='windows']) .dl[data-platform='macos'] .req,
  :global(:root[data-os='macos']) .dl[data-platform='windows'] .req {
    display: none;
  }

  :global(:root[data-os='windows']) .dl[data-platform='macos'] .title,
  :global(:root[data-os='macos']) .dl[data-platform='windows'] .title {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--ink-quiet);
  }

  :global(:root[data-os='windows']) .dl[data-platform='macos']:hover,
  :global(:root[data-os='macos']) .dl[data-platform='windows']:hover {
    border-color: transparent;
    background: none;
    box-shadow: none;
  }

  :global(:root[data-os='windows']) .dl[data-platform='macos']:hover .title,
  :global(:root[data-os='macos']) .dl[data-platform='windows']:hover .title {
    color: var(--color-accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  :global(:root[data-os='windows']) .dl[data-platform='macos']:hover .glyph,
  :global(:root[data-os='macos']) .dl[data-platform='windows']:hover .glyph {
    color: var(--color-accent);
  }

  /* Sized and coloured as a footnote, not a warning: it is a step, not a
     hazard, and a banner-shaped treatment here would say the download is
     unsafe. Same quiet ink as .meta for the same contrast reason. */
  .macnote {
    max-width: 22rem;
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--ink-quiet);
    text-align: center;
  }

  .macnote a {
    color: var(--ink-quiet);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--ink-quiet) 45%, transparent);
    text-underline-offset: 3px;
  }

  .macnote a:hover {
    color: var(--color-accent);
    text-decoration-color: currentColor;
  }

  :global(:root[data-os='windows']) .macnote {
    display: none;
  }

  /* --ink-quiet, not --ink-off: this line carries the version number someone
     checks before downloading, and 28% white on near-black is under 2.5:1 —
     decorative contrast on text that is not decoration. */
  .meta {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    color: var(--ink-quiet);
  }

  .meta a {
    color: var(--color-accent);
  }

  .meta a:hover {
    text-decoration: underline;
  }
</style>

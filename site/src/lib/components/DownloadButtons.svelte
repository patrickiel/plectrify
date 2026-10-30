<script lang="ts">
  import { DOWNLOADS } from '$lib/site';

  /**
   * Every platform, always all shown, but the one that will actually run on
   * this machine leads.
   *
   * The ranking is done in CSS off `<html data-os>`, which the inline probe in
   * app.html stamps before first paint. It cannot be done in component code:
   * every page is prerendered, so the server has no idea what OS is asking, and
   * promoting a button after hydration would re-rank them a beat after the page
   * appears, and the reader would watch the buttons change under the cursor.
   *
   * Three states, and the third is the point:
   *
   *   windows  : the Windows build is the filled accent button, the others quiet
   *   macos    : the same for macOS
   *   linux    : the same for Linux
   *   unknown  : all keep equal weight
   *
   * "Unknown" is not a failure case to be papered over. A phone or a tablet
   * gets it, and a reader on a phone is choosing what to install on a
   * machine that is somewhere else, exactly the case a guess gets wrong. The
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
        {:else if dl.platform === 'linux'}
          <!-- Tux from Devicon (linux-plain, MIT), shared with
               Assets/DownloadButton.html. Drawn on a 128 grid. -->
          <svg class="glyph" viewBox="0 0 128 128" fill="currentColor" aria-hidden="true">
            <path
              fill-rule="evenodd"
              d="M113.823 104.595c-1.795-1.478-3.629-2.921-5.308-4.525-1.87-1.785-3.045-3.944-2.789-6.678.147-1.573-.216-2.926-2.113-3.452.446-1.154.864-1.928 1.033-2.753.188-.92.178-1.887.204-2.834.264-9.96-3.334-18.691-8.663-26.835-2.454-3.748-5.017-7.429-7.633-11.066-4.092-5.688-5.559-12.078-5.633-18.981a47.564 47.564 0 00-1.081-9.475C80.527 11.956 77.291 7.233 71.422 4.7c-4.497-1.942-9.152-2.327-13.901-1.084-6.901 1.805-11.074 6.934-10.996 14.088.074 6.885.417 13.779.922 20.648.288 3.893-.312 7.252-2.895 10.34-2.484 2.969-4.706 6.172-6.858 9.397-1.229 1.844-2.317 3.853-3.077 5.931-2.07 5.663-3.973 11.373-7.276 16.5-1.224 1.9-1.363 4.026-.494 6.199.225.563.363 1.429.089 1.882-2.354 3.907-5.011 7.345-10.066 8.095-3.976.591-4.172 1.314-4.051 5.413.1 3.337.061 6.705-.28 10.021-.363 3.555.008 4.521 3.442 5.373 7.924 1.968 15.913 3.647 23.492 6.854 3.227 1.365 6.465.891 9.064-1.763 2.713-2.771 6.141-3.855 9.844-3.859 6.285-.005 12.572.298 18.86.369 1.702.02 2.679.653 3.364 2.199.84 1.893 2.26 3.284 4.445 3.526 4.193.462 8.013-.16 11.19-3.359 3.918-3.948 8.436-7.066 13.615-9.227 1.482-.619 2.878-1.592 4.103-2.648 2.231-1.922 2.113-3.146-.135-5zM62.426 24.12c.758-2.601 2.537-4.289 5.243-4.801 2.276-.43 4.203.688 5.639 3.246 1.546 2.758 2.054 5.64.734 8.658-1.083 2.474-1.591 2.707-4.123 1.868-.474-.157-.937-.343-1.777-.652.708-.594 1.154-1.035 1.664-1.382 1.134-.772 1.452-1.858 1.346-3.148-.139-1.694-1.471-3.194-2.837-3.175-1.225.017-2.262 1.167-2.4 2.915-.086 1.089.095 2.199.173 3.589-3.446-1.023-4.711-3.525-3.662-7.118zm-12.75-2.251c1.274-1.928 3.197-2.314 5.101-1.024 2.029 1.376 3.547 5.256 2.763 7.576-.285.844-1.127 1.5-1.716 2.241l-.604-.374c-.23-1.253-.276-2.585-.757-3.733-.304-.728-1.257-1.184-1.919-1.762-.622.739-1.693 1.443-1.757 2.228-.088 1.084.477 2.28.969 3.331.311.661 1.001 1.145 1.713 1.916l-1.922 1.51c-3.018-2.7-3.915-8.82-1.871-11.909zM87.34 86.075c-.203 2.604-.5 2.713-3.118 3.098-1.859.272-2.359.756-2.453 2.964a101.744 101.744 0 00-.012 7.753c.061 1.77-.537 3.158-1.755 4.393-6.764 6.856-14.845 10.105-24.512 8.926-4.17-.509-6.896-3.047-9.097-6.639.98-.363 1.705-.607 2.412-.894 3.122-1.27 3.706-3.955 1.213-6.277-1.884-1.757-3.986-3.283-6.007-4.892-1.954-1.555-3.934-3.078-5.891-4.629-1.668-1.323-2.305-3.028-2.345-5.188-.094-5.182.972-10.03 3.138-14.747 1.932-4.209 3.429-8.617 5.239-12.885.935-2.202 1.906-4.455 3.278-6.388 1.319-1.854 2.134-3.669 1.988-5.94-.084-1.276-.016-2.562-.016-3.843l.707-.352c1.141.985 2.302 1.949 3.423 2.959 4.045 3.646 7.892 3.813 12.319.67 1.888-1.341 3.93-2.47 5.927-3.652.497-.294 1.092-.423 1.934-.738 2.151 5.066 4.262 10.033 6.375 15 1.072 2.524 1.932 5.167 3.264 7.547 2.671 4.775 4.092 9.813 4.07 15.272-.012 2.83.137 5.67-.081 8.482z"
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
        </span>
      </a>
    {/each}
    <!-- No version number and no releases link. Nobody needs either before
         clicking (the button already points at the current release), and
         printing them turns a call to action into a changelog line. Whoever
         does want past versions has the footer's Releases link. -->
  </div>

  <!-- The macOS build is not notarized, so the first launch is refused and the
       wording macOS uses is "damaged", and a reader who meets that with no warning
       concludes the download is broken and leaves. Said here, before the click,
       it is a known one-time step instead.

       Shown to everyone *except* a detected Windows or Linux machine, using the
       same data-os hook the ranking uses: on an unknown OS (a phone, a tablet)
       the reader is very likely choosing what to install on some other
       machine, and that machine may well be the Mac. Only a detected desktop
       that is not a Mac can be ruled out. -->
  <p class="macnote">
    <a href="/docs/opening-on-macos">macOS blocks the first launch: how to open it</a>
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
      flex-wrap: wrap;
      justify-content: center;
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

  /* ── Promoted: the build that runs on this machine ──────────────────────
     A solid accent fill, and `order: -1` so it comes first in both the row and
     the stacked column. Colour alone is never the signal: the button says
     which OS it is, and it moves to the front. */
  :global(:root[data-os='windows']) .dl[data-platform='windows'],
  :global(:root[data-os='macos']) .dl[data-platform='macos'],
  :global(:root[data-os='linux']) .dl[data-platform='linux'] {
    order: -1;
    grid-column: 1 / -1;
    justify-self: center;
    border-color: var(--color-accent);
    background: var(--color-accent);
    box-shadow: var(--shadow-glow-accent-sm);
  }

  :global(:root[data-os='windows']) .dl[data-platform='windows']:hover,
  :global(:root[data-os='macos']) .dl[data-platform='macos']:hover,
  :global(:root[data-os='linux']) .dl[data-platform='linux']:hover {
    background: color-mix(in srgb, var(--color-accent) 88%, #fff);
    box-shadow: var(--shadow-glow-accent);
  }

  /* Everything sitting *on* the accent fill switches to the ink meant for it:
     black here, and defined as a token so it stays right if the accent moves. */
  :global(:root[data-os='windows']) .dl[data-platform='windows'] .glyph,
  :global(:root[data-os='macos']) .dl[data-platform='macos'] .glyph,
  :global(:root[data-os='linux']) .dl[data-platform='linux'] .glyph,
  :global(:root[data-os='windows']) .dl[data-platform='windows'] .title,
  :global(:root[data-os='macos']) .dl[data-platform='macos'] .title,
  :global(:root[data-os='linux']) .dl[data-platform='linux'] .title {
    color: var(--color-accent-ink);
  }

  /* ── Demoted: the other platform, reduced to a link underneath ───────────
     Once we know which build runs on this machine, the others are footnotes
     rather than more calls to action. Each non-matching entry drops its
     border, fill and padding to read as a plain quiet link below the button.

     It keeps its glyph, because this is still the control someone downloading
     for their *other* machine clicks. The system requirements travel with the
     file, on the releases page, rather than under the button.

     The transparent border rather than `border: 0` is deliberate: it holds the
     same box size, so switching states never nudges the layout.

     A grid rather than a column: the promoted button sets the column, and the
     demoted links are centred under it rather than hugging its left edge. */
  :global(:root[data-os='windows']) .row,
  :global(:root[data-os='macos']) .row,
  :global(:root[data-os='linux']) .row {
    display: grid;
    grid-template-columns: auto;
    align-items: center;
    justify-content: center;
    justify-items: center;
    gap: 0.85rem;
  }

  :global(:root[data-os='windows']) .dl:not([data-platform='windows']),
  :global(:root[data-os='macos']) .dl:not([data-platform='macos']),
  :global(:root[data-os='linux']) .dl:not([data-platform='linux']) {
    gap: 0.45rem;
    padding: 0.15rem 0.25rem;
    border-color: transparent;
    background: none;
    box-shadow: none;
  }

  :global(:root[data-os='windows']) .dl:not([data-platform='windows']) .glyph,
  :global(:root[data-os='macos']) .dl:not([data-platform='macos']) .glyph,
  :global(:root[data-os='linux']) .dl:not([data-platform='linux']) .glyph {
    width: 0.85rem;
    height: 0.85rem;
    color: var(--ink-off);
  }

  :global(:root[data-os='windows']) .dl:not([data-platform='windows']) .title,
  :global(:root[data-os='macos']) .dl:not([data-platform='macos']) .title,
  :global(:root[data-os='linux']) .dl:not([data-platform='linux']) .title {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--ink-quiet);
  }

  :global(:root[data-os='windows']) .dl:not([data-platform='windows']):hover,
  :global(:root[data-os='macos']) .dl:not([data-platform='macos']):hover,
  :global(:root[data-os='linux']) .dl:not([data-platform='linux']):hover {
    border-color: transparent;
    background: none;
    box-shadow: none;
  }

  :global(:root[data-os='windows']) .dl:not([data-platform='windows']):hover .title,
  :global(:root[data-os='macos']) .dl:not([data-platform='macos']):hover .title,
  :global(:root[data-os='linux']) .dl:not([data-platform='linux']):hover .title {
    color: var(--color-accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  :global(:root[data-os='windows']) .dl:not([data-platform='windows']):hover .glyph,
  :global(:root[data-os='macos']) .dl:not([data-platform='macos']):hover .glyph,
  :global(:root[data-os='linux']) .dl:not([data-platform='linux']):hover .glyph {
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

  :global(:root[data-os='windows']) .macnote,
  :global(:root[data-os='linux']) .macnote {
    display: none;
  }
</style>

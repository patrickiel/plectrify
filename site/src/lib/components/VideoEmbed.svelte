<script lang="ts">
  /**
   * A click-to-load YouTube embed.
   *
   * The iframe is not in the document until the reader asks for it. A YouTube
   * embed pulls roughly half a megabyte of third-party JavaScript and sets
   * cookies on page load, on a page most readers will never press play on, so
   * the resting state is a poster and a play button, and the iframe replaces it
   * on click. `youtube-nocookie.com` and `autoplay=1` mean that one click both
   * starts the video and keeps the tracking cookie off the page.
   *
   * With no `id` yet, it renders an honest placeholder, but *not* at 16:9. An
   * empty frame that reserves the video's full aspect ratio hands a screen and
   * a half of the landing page to a box with two sentences in it, which is a
   * louder way of saying "nothing here yet" than the words are. The placeholder
   * sizes to its own content instead, and only the real embed claims 16:9.
   */
  interface Props {
    id: string | null;
    title: string;
    /** Poster image URL. Falls back to YouTube's own thumbnail. */
    poster?: string;
  }

  let { id, title, poster }: Props = $props();

  let playing = $state(false);

  const posterSrc = $derived(
    poster ?? (id ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : null),
  );
</script>

<div
  class="surface relative w-full overflow-hidden shadow-[var(--shadow-panel)]"
  class:aspect-video={id !== null}
>
  {#if playing && id}
    <iframe
      class="absolute inset-0 size-full"
      src="https://www.youtube-nocookie.com/embed/{id}?autoplay=1&rel=0"
      {title}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen
    ></iframe>
  {:else if id}
    <button
      type="button"
      onclick={() => (playing = true)}
      class="group absolute inset-0 flex size-full cursor-pointer items-center justify-center"
      aria-label="Play video: {title}"
    >
      {#if posterSrc}
        <img
          src={posterSrc}
          alt=""
          loading="lazy"
          class="absolute inset-0 size-full object-cover opacity-70 transition-opacity group-hover:opacity-90"
        />
      {/if}
      <span
        class="text-accent relative flex size-16 items-center justify-center rounded-full border border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)] backdrop-blur-sm transition-[box-shadow,transform] group-hover:scale-105 group-hover:shadow-[var(--shadow-glow-accent)]"
      >
        <svg class="ml-1 size-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path
            d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.3-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z"
          />
        </svg>
      </span>
    </button>
  {:else}
    <div class="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <svg
        class="text-control-off size-9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        aria-hidden="true"
      >
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
        <path d="m10 9.5 5 2.5-5 2.5z" stroke-linejoin="round" />
      </svg>
      <p class="text-control-quiet font-mono text-[0.7rem] tracking-[0.1em] uppercase">
        Demo video coming soon
      </p>
      <p class="text-muted max-w-sm text-sm">
        In the meantime, the docs cover the same ground, from picking an audio device to saving your
        first rig.
      </p>
    </div>
  {/if}
</div>

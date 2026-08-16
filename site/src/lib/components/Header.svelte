<script lang="ts">
  import { page } from '$app/state';
  import { NAV, PRODUCT, REPO, DISCORD_URL } from '$lib/site';
  import GitHubGlyph from './GitHubGlyph.svelte';
  import DiscordGlyph from './DiscordGlyph.svelte';
  import Brandmark from './Brandmark.svelte';

  /**
   * The sticky top bar, wearing the app's chrome surface so the site's frame
   * and the product's frame are visibly the same material.
   *
   * There is no hamburger menu and no open/closed state: four links fit on a
   * phone once the two that only make sense beside a hero ("Features",
   * "Demo") drop out below `sm`. A menu button would be JavaScript, a focus
   * trap and an escape-key handler bought for four links.
   *
   * It wears that chrome only once there is something under it to be chrome
   * *over*. The bar is sticky in normal flow, not fixed, so at the top of any
   * page nothing is behind it, and --color-chrome is several shades lighter
   * than --color-space, so an always-on fill puts a grey slab across the top of
   * a near-black page and makes the loudest thing on first paint a navigation
   * bar rather than the headline. Below the fold it earns its keep, and fades
   * in with its border and blur.
   *
   * `bind:scrollY` rather than a listener: it is one binding, it needs no
   * cleanup, and it cannot leak. The threshold is a few pixels rather than
   * zero so a rubber-band scroll does not flicker the bar.
   */
  const isDocs = $derived(page.url.pathname.startsWith('/docs'));

  let scrollY = $state(0);
  const lifted = $derived(scrollY > 8);

  // Each time the bar gains or loses its chrome, the logo coin takes another
  // half turn. Only toggles count: comparing against the previous value
  // keeps the mount from spending a spin on first paint. Hover is not added
  // here: it is one more half turn in the CSS, so it can unwind on leave
  // while these accumulate forward.
  let spins = $state(0);
  let prevLifted: boolean | undefined;
  $effect(() => {
    if (prevLifted !== undefined && lifted !== prevLifted) spins++;
    prevLifted = lifted;
  });
</script>

<svelte:window bind:scrollY />

<header
  class="sticky top-0 z-50 border-b transition-[background-color,border-color,backdrop-filter] duration-200
         {lifted
    ? 'border-[color:var(--edge-soft)] bg-[var(--color-chrome)] backdrop-blur-xl'
    : 'border-transparent bg-transparent'}"
>
  <nav
    class="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5 sm:px-8"
    aria-label="Primary navigation"
  >
    <a href="/" class="text-ink hover:text-accent flex shrink-0 items-center transition-colors">
      <Brandmark {spins} interactive />
    </a>

    <div class="flex-1"></div>

    <!-- The links are set as control labels, so they are marked like control
         labels: the accent rule under the one you are on, and under the one
         under the cursor. A filled pill behind mono uppercase reads as a
         button, and none of these are buttons. -->
    <ul class="flex items-center gap-0.5 font-mono text-[0.8rem] tracking-[0.06em]">
      {#each NAV as item (item.href)}
        {@const isCurrent = item.href === '/docs' && isDocs}
        <li class={item.href.startsWith('/#') ? 'hidden sm:block' : ''}>
          <a
            href={item.href}
            aria-current={isCurrent ? 'page' : undefined}
            class="hover:text-ink hover:decoration-accent px-2.5 py-2 uppercase underline decoration-2 underline-offset-[0.6rem] transition-colors
                   {isCurrent
              ? 'text-accent decoration-accent'
              : 'text-control-quiet decoration-transparent'}"
          >
            {item.label}
          </a>
        </li>
      {/each}
      <li>
        <a
          href={DISCORD_URL}
          rel="noreferrer noopener"
          target="_blank"
          title="{PRODUCT} on Discord"
          class="rounded-control-sm text-control-quiet hover:bg-control-hover hover:text-ink ml-1.5 flex size-9 items-center justify-center transition-colors"
        >
          <DiscordGlyph class="size-[1.15rem]" />
          <span class="sr-only">Community on Discord</span>
        </a>
      </li>
      <li>
        <a
          href={REPO}
          rel="noreferrer noopener"
          target="_blank"
          title="{PRODUCT} on GitHub"
          class="rounded-control-sm text-control-quiet hover:bg-control-hover hover:text-ink flex size-9 items-center justify-center transition-colors"
        >
          <GitHubGlyph class="size-[1.15rem]" />
          <span class="sr-only">Source on GitHub</span>
        </a>
      </li>
    </ul>
  </nav>
</header>

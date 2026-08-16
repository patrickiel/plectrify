<script lang="ts">
  import { PRODUCT, REPO, RELEASES_URL, DISCORD_URL } from '$lib/site';
  import GitHubGlyph from './GitHubGlyph.svelte';
  import DiscordGlyph from './DiscordGlyph.svelte';
  import Brandmark from './Brandmark.svelte';

  const links = [
    {
      heading: 'Product',
      items: [
        { label: 'Features', href: '/#features' },
        { label: 'Practice and stage', href: '/#practice' },
        { label: 'Demo', href: '/#video' },
        { label: 'Download', href: '/#download' },
        { label: 'Releases', href: RELEASES_URL, external: true },
      ],
    },
    {
      heading: 'Docs',
      items: [
        { label: 'Getting started', href: '/docs/getting-started' },
        { label: 'Building a rig', href: '/docs/rigs' },
        { label: 'Knobs and patches', href: '/docs/patches' },
        { label: 'Troubleshooting', href: '/docs/troubleshooting' },
      ],
    },
    {
      heading: 'Project',
      items: [
        { label: 'Source', href: REPO, external: true },
        { label: 'Report a bug', href: `${REPO}/issues/new/choose`, external: true },
        { label: 'Licence (AGPL-3.0)', href: `${REPO}/blob/main/LICENSE`, external: true },
      ],
    },
  ];
</script>

<footer class="border-control-edge-hair bg-chrome mt-24 border-t">
  <div class="mx-auto max-w-6xl px-5 py-12 sm:px-8">
    <div class="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
      <div>
        <Brandmark icon={1.5} />
        <p class="text-muted mt-3 max-w-xs text-sm leading-relaxed">
          A guitar rig for your computer. Install it, plug in, and play.
        </p>
        <div class="mt-4 flex flex-col items-start gap-2">
          <a
            href={REPO}
            rel="noreferrer noopener"
            target="_blank"
            class="text-control-quiet hover:text-accent inline-flex items-center gap-2 font-mono text-[0.68rem] tracking-[0.08em] uppercase transition-colors"
          >
            <GitHubGlyph class="size-4" />
            GitHub
          </a>
          <a
            href={DISCORD_URL}
            rel="noreferrer noopener"
            target="_blank"
            class="text-control-quiet hover:text-accent inline-flex items-center gap-2 font-mono text-[0.68rem] tracking-[0.08em] uppercase transition-colors"
          >
            <DiscordGlyph class="size-4" />
            Discord
          </a>
        </div>
      </div>

      {#each links as group (group.heading)}
        <div>
          <h2
            class="text-control-off font-mono text-[0.62rem] font-semibold tracking-[0.16em] uppercase"
          >
            {group.heading}
          </h2>
          <ul class="mt-3 space-y-2">
            {#each group.items as item (item.label)}
              <li>
                <a
                  href={item.href}
                  rel={item.external ? 'noreferrer noopener' : undefined}
                  target={item.external ? '_blank' : undefined}
                  class="text-control-body hover:text-accent text-sm transition-colors"
                >
                  {item.label}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>

    <div
      class="text-control-off border-control-edge-hair mt-10 flex flex-col gap-2 border-t pt-6 font-mono text-[0.64rem] tracking-[0.06em] sm:flex-row sm:items-center sm:justify-between"
    >
      <p>© {new Date().getFullYear()} {PRODUCT}. AGPL-3.0.</p>
      <p>No account, no telemetry, no DRM.</p>
    </div>
  </div>
</footer>

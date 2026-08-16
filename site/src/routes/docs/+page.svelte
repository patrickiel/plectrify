<script lang="ts">
  import { DOC_NAV } from '$lib/docs/nav';
  import { PRODUCT } from '$lib/site';
</script>

<svelte:head>
  <title>Documentation · {PRODUCT}</title>
  <meta
    name="description"
    content="How to set up {PRODUCT}, build a rig, map knobs into patches, and fix the things that usually go wrong."
  />
</svelte:head>

<p class="eyebrow">Documentation</p>
<h1 class="mt-4 text-4xl font-semibold tracking-tight text-balance">
  Everything from first sound to saved rig.
</h1>
<p class="text-muted mt-4 max-w-xl text-lg text-pretty">
  Short pages, in the order you will need them. If you have just installed {PRODUCT}, start at the
  top.
</p>

{#each DOC_NAV as section (section.heading)}
  <section class="mt-12">
    <h2 class="text-control-off font-mono text-[0.62rem] font-semibold tracking-[0.16em] uppercase">
      {section.heading}
    </h2>
    <div class="mt-4 grid gap-3 sm:grid-cols-2">
      {#each section.links as link (link.href)}
        <a
          href={link.href}
          class="surface group p-5 transition-colors hover:border-[color:var(--edge)]"
        >
          <h3 class="text-ink group-hover:text-accent font-semibold tracking-tight">
            {link.label}
          </h3>
          <p class="text-muted mt-1.5 text-sm leading-relaxed">{link.blurb}</p>
        </a>
      {/each}
    </div>
  </section>
{/each}

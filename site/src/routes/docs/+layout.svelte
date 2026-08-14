<script lang="ts">
  import { page } from '$app/state';
  import { DOC_NAV } from '$lib/docs/nav';

  let { children } = $props();

  const current = $derived(page.url.pathname);
</script>

<div class="mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:px-8 lg:grid-cols-[15rem_1fr] lg:gap-14">
  <!-- On a phone this sits above the content as a plain list rather than
       collapsing behind a disclosure: six links are shorter than the button,
       the label and the state it would take to hide them. -->
  <nav class="lg:sticky lg:top-24 lg:self-start" aria-label="Documentation">
    {#each DOC_NAV as section (section.heading)}
      <div class="mb-7">
        <h2
          class="text-control-off mb-2.5 font-mono text-[0.6rem] font-semibold tracking-[0.16em] uppercase"
        >
          {section.heading}
        </h2>
        <ul class="space-y-0.5">
          {#each section.links as link (link.href)}
            {@const active = current === link.href}
            <li>
              <a
                href={link.href}
                aria-current={active ? 'page' : undefined}
                class="rounded-control-sm block border-l-2 py-1.5 pl-3 text-sm transition-colors
                       {active
                  ? 'border-accent bg-control-rest text-accent font-medium'
                  : 'text-control-body hover:bg-control-rest hover:text-ink border-transparent hover:border-[color:var(--edge)]'}"
              >
                {link.label}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </nav>

  <div class="min-w-0">
    {@render children()}
  </div>
</div>

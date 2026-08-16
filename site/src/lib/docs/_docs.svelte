<script lang="ts">
  import { page } from '$app/state';
  import { PRODUCT } from '$lib/site';
  import { ALL_DOCS } from './nav';

  /**
   * The wrapper every `.md` under /docs is compiled into (wired up in
   * svelte.config.js), so a doc is a file with frontmatter and prose and never
   * has to import a layout of its own.
   *
   * `title` and `description` arrive as props from the file's frontmatter.
   * The prose styling lives here rather than in app.css because it applies to
   * markdown-generated elements, which carry no classes to hook; a scoped
   * `:global` block under one wrapper class is the narrowest way to reach them.
   */
  interface Props {
    title?: string;
    description?: string;
    children?: import('svelte').Snippet;
  }

  let { title, description, children }: Props = $props();

  /** Previous/next, derived from the same order the sidebar renders. */
  const index = $derived(ALL_DOCS.findIndex((d) => d.href === page.url.pathname));
  const prev = $derived(index > 0 ? ALL_DOCS[index - 1] : null);
  const next = $derived(index >= 0 && index < ALL_DOCS.length - 1 ? ALL_DOCS[index + 1] : null);
</script>

<svelte:head>
  <title>{title ? `${title} · ${PRODUCT} docs` : `${PRODUCT} docs`}</title>
  {#if description}
    <meta name="description" content={description} />
  {/if}
</svelte:head>

<article class="doc-prose">
  {#if title}
    <h1>{title}</h1>
  {/if}
  {#if description}
    <p class="lead">{description}</p>
  {/if}
  {@render children?.()}
</article>

{#if prev || next}
  <nav
    class="mt-14 flex flex-col gap-3 border-t border-[color:var(--edge-hair)] pt-6 sm:flex-row sm:justify-between"
    aria-label="Documentation pages"
  >
    {#if prev}
      <a
        href={prev.href}
        class="group rounded-control-md hover:bg-control-rest border border-[color:var(--edge-hair)] px-4 py-3 transition-colors hover:border-[color:var(--edge)]"
      >
        <span class="text-control-off block font-mono text-[0.6rem] tracking-[0.14em] uppercase">
          ← Previous
        </span>
        <span class="text-control-body group-hover:text-accent mt-1 block text-sm font-medium">
          {prev.label}
        </span>
      </a>
    {:else}
      <span></span>
    {/if}
    {#if next}
      <a
        href={next.href}
        class="group rounded-control-md hover:bg-control-rest border border-[color:var(--edge-hair)] px-4 py-3 transition-colors hover:border-[color:var(--edge)] sm:text-right"
      >
        <span class="text-control-off block font-mono text-[0.6rem] tracking-[0.14em] uppercase">
          Next →
        </span>
        <span class="text-control-body group-hover:text-accent mt-1 block text-sm font-medium">
          {next.label}
        </span>
      </a>
    {/if}
  </nav>
{/if}

<style>
  /* Markdown output carries no classes, so everything is reached by element
     under one wrapper. Sizes and colours come from the same tokens the app
     uses; nothing here invents a value. */
  .doc-prose {
    color: var(--ink-body);
    line-height: 1.7;
  }

  .doc-prose :global(h1) {
    font-size: 2.25rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--color-ink);
    text-wrap: balance;
  }

  .doc-prose :global(.lead) {
    margin-top: 0.85rem;
    font-size: 1.1rem;
    color: var(--color-muted);
    text-wrap: pretty;
  }

  .doc-prose :global(h2) {
    margin-top: 3rem;
    margin-bottom: 1rem;
    padding-top: 1.75rem;
    border-top: 1px solid var(--edge-hair);
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--color-ink);
  }

  .doc-prose :global(h3) {
    margin-top: 2rem;
    margin-bottom: 0.6rem;
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--color-ink);
  }

  .doc-prose :global(p),
  .doc-prose :global(ul),
  .doc-prose :global(ol) {
    margin-block: 1rem;
  }

  .doc-prose :global(ul),
  .doc-prose :global(ol) {
    padding-left: 1.35rem;
  }

  .doc-prose :global(ul) {
    list-style: disc;
  }

  .doc-prose :global(ol) {
    list-style: decimal;
  }

  .doc-prose :global(li) {
    margin-block: 0.4rem;
    padding-left: 0.25rem;
  }

  .doc-prose :global(li::marker) {
    color: var(--ink-off);
  }

  .doc-prose :global(strong) {
    font-weight: 600;
    color: var(--color-ink);
  }

  .doc-prose :global(a) {
    color: var(--color-accent);
    text-underline-offset: 3px;
  }

  .doc-prose :global(a:hover) {
    text-decoration: underline;
  }

  /* Inline code: a recessed chip, the app's idiom for a readout. */
  .doc-prose :global(code) {
    font-family: var(--font-mono);
    font-size: 0.85em;
    padding: 0.15em 0.4em;
    border: 1px solid var(--edge-hair);
    border-radius: var(--ctl-r-xs);
    background: var(--color-well);
    color: var(--color-ink);
  }

  .doc-prose :global(pre) {
    margin-block: 1.25rem;
    padding: 1rem 1.15rem;
    overflow-x: auto;
    border: 1px solid var(--edge-hair);
    border-radius: var(--ctl-r-lg);
    background: var(--color-menu);
    font-size: 0.85rem;
    line-height: 1.6;
  }

  /* A fenced block's own chip styling would double the border inside <pre>. */
  .doc-prose :global(pre code) {
    padding: 0;
    border: 0;
    background: none;
    font-size: inherit;
  }

  .doc-prose :global(blockquote) {
    margin-block: 1.25rem;
    padding: 0.85rem 1.15rem;
    border-left: 2px solid var(--color-accent);
    border-radius: 0 var(--ctl-r-sm) var(--ctl-r-sm) 0;
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
    color: var(--color-muted);
  }

  .doc-prose :global(blockquote p) {
    margin-block: 0;
  }

  .doc-prose :global(hr) {
    margin-block: 2.5rem;
    border: 0;
    border-top: 1px solid var(--edge-hair);
  }

  /* Wide tables scroll inside their own box rather than widening the page. */
  .doc-prose :global(table) {
    display: block;
    overflow-x: auto;
    width: 100%;
    margin-block: 1.25rem;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  .doc-prose :global(th) {
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--edge);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-align: left;
    text-transform: uppercase;
    color: var(--ink-quiet);
    white-space: nowrap;
  }

  .doc-prose :global(td) {
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--edge-hair);
    vertical-align: top;
  }
</style>

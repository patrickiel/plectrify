<script lang="ts">
  import '../app.css';
  import Header from '$lib/components/Header.svelte';
  import Footer from '$lib/components/Footer.svelte';

  let { children } = $props();
</script>

<a
  href="#main"
  class="rounded-control-sm bg-accent text-accent-ink sr-only px-4 py-2 font-mono text-sm focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-60"
>
  Skip to content
</a>

<div class="flex min-h-screen flex-col">
  <Header />
  <main id="main" class="flex-1">
    {@render children()}
  </main>
  <Footer />
</div>

<script lang="ts">
  import { PRODUCT } from '$lib/site';

  /* The registered TONE3000 OAuth redirect target.
   *
   * In the normal flow this page is never rendered. Plectrify signs in inside its
   * own window and cancels the navigation the instant TONE3000 redirects here,
   * reading the authorization code straight off the URL, so the browser never
   * fetches this document at all.
   *
   * It exists for two reasons anyway. TONE3000 will only accept a redirect URI
   * that is real and reachable, so a 404 here would break sign-in before it
   * started. And it is the fallback: if a server-side redirect ever arrives in
   * a form the app cannot veto, the navigation completes, this page loads, and
   * the app reads the code from the finished URL instead. Either way the user
   * should see something calm and finished rather than a blank tab.
   *
   * DELIBERATELY NO JAVASCRIPT TOUCHES THE CODE. This is a landing target, not
   * a token exchanger: the authorization code in the query is Plectrify's to
   * redeem, on the user's own machine, with a PKCE verifier that never leaves
   * it. Nothing here reads the query, stores it, or sends it anywhere, and
   * nothing here ever should. There is no server behind this site to send it
   * to, which is the point.
   */
</script>

<svelte:head>
  <title>Signing in to TONE3000 · {PRODUCT}</title>
  <!-- A transient step in someone's sign-in, not a page anyone should find in
       search results. -->
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<section class="mx-auto flex max-w-xl flex-col items-center gap-6 px-6 py-24 text-center">
  <h1 class="text-2xl font-semibold tracking-tight">You're signed in</h1>

  <p class="text-muted leading-relaxed">
    {PRODUCT} has what it needs from TONE3000. You can close this window and go back to the app; your
    tones are waiting there.
  </p>

  <p class="text-muted/70 text-sm leading-relaxed">
    If {PRODUCT} didn't pick this up automatically, close this window and try connecting again from the
    TONE3000 panel.
  </p>
</section>

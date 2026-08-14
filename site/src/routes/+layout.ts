/** Every route is prerendered — this is a static site with no server behind it.
    Setting it once at the root means a new page is prerendered by default
    rather than by remembering to opt in. */
export const prerender = true;

/** No client-side router state depends on the URL beyond the page itself, and
    turning SSR off would ship an empty document to crawlers. */
export const ssr = true;

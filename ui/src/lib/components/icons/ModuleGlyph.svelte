<script lang="ts">
  import type { ModuleIcon } from '../../engine/moduleAppearance';
  import { MODULE_GLYPHS } from './moduleGlyphs';

  interface Props {
    icon: ModuleIcon;
    /** Rendered square size in px. */
    size?: number;
  }

  let { icon, size = 18 }: Props = $props();
</script>

<!-- Stroke-based and coloured by currentColor, so the glyph adopts whatever
     tint its surroundings wear (card header, drawer tile, picker button).
     Decorative: the accessible name lives on the element that carries it. -->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={MODULE_GLYPHS[icon].d} />
</svg>

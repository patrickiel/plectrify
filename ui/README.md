# Plectrify UI

Minimal guitar-rig front-end — **Svelte 5 + TypeScript + TailwindCSS**, built
standalone against a mock engine. Wires into the native JUCE host (via
`juce::WebBrowserComponent`) in a later pass; the UI code won't change because
both talk to the same `EngineBridge` interface.

```sh
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # static assets in dist/ (the ship path)
pnpm check    # svelte-check type check
pnpm format   # format Svelte, TypeScript, CSS, and Tailwind classes
pnpm format:check # verify formatting without changing files
```

Prettier runs automatically on save in VS Code when the recommended extension
is installed. Tailwind utility classes are sorted using the project's Tailwind
v4 stylesheet; long Tailwind strings are soft-wrapped at 100 columns in Svelte
files so they remain readable without changing their runtime value.

## Layout (vertical slices)

```
src/
  lib/engine/     EngineBridge.ts (contract), MockEngine.ts, types.ts
  features/
    rack/         Rack.svelte     — the chain strip + add controls
    module/       ModuleCard.svelte — category badge, bypass, knobs
    knob/         Knob.svelte     — reusable two-way rotary
  App.svelte, main.ts, app.css
```

To connect real audio later, implement `EngineBridge` with the JUCE bridge and
swap the `MockEngine` line in `App.svelte`.

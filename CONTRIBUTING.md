# Contributing to Plectrify

Thanks for your interest! This guide gets you from a clone to a running,
tested build. For the architecture, code style and repository layout in depth,
read [AGENTS.md](AGENTS.md) — it is the canonical developer reference (written
for AI coding agents, equally useful for humans).

## Prerequisites

- **Windows 11** with **Visual Studio 2022/18** and the *Desktop development
  with C++* workload (bundles CMake — neither `cmake` nor `cl` needs to be on
  PATH; the scripts find the VS-bundled binaries), **or macOS 13.3+ on Apple
  Silicon** with the Xcode Command Line Tools, CMake and (optionally) Ninja.
- **Node.js** with **pnpm** (the UI uses pnpm, not npm).

## Build and run

One command on both OSes (`pnpm install` once at the repo root first):

```sh
pnpm app             # dev loop: Vite HMR server + Debug app pointed at it
pnpm app --ui-only   # rebuild ui/dist + relaunch (no cmake)
pnpm app --dist      # ship path: UI format/check/test/build, cmake, native tests, launch
pnpm app --dist --no-ui    # skip the Svelte build (C++ only)
pnpm app --dist --no-run   # build + test only, don't launch
pnpm app --clean           # rebuild the native target from scratch
pnpm app --dist --config Release  # Release build (stages ui/ where the OS serves it)
```

The first CMake configure downloads JUCE (~1 min; on Windows also the WebView2
SDK package — macOS needs none, WKWebView ships with the OS). The app serves
the Svelte UI from `ui/dist`, so the UI must be built before the native app can
show anything — `pnpm app` handles the ordering.

The UI also runs fully standalone in a browser against a mock engine — the
fastest loop for pure UI work:

```sh
cd ui
pnpm install
pnpm dev      # http://localhost:5173 — no native build needed
```

## Architecture in one paragraph

The UI and the audio engine are decoupled by a single contract,
`ui/src/lib/engine/EngineBridge.ts`, implemented twice: `MockEngine` (plain
browser) and `JuceEngine` (inside the host, events over `window.__JUCE__`).
The UI never imports JUCE and never changes when moving from mock to real
audio — keep it that way. When adding a UI↔engine capability: extend
`EngineBridge`, implement it in **both** engines, and wire the matching event
handler in `Source/app/MainComponent.cpp`. Details in
[AGENTS.md](AGENTS.md#architecture).

## Testing

All of these run automatically in `pnpm app --dist`:

- **Native** (CTest, `Tests/`): tuner DSP and headless rack-graph topology.
- **UI**: `pnpm format:check` (Prettier + Tailwind class order), `pnpm check`
  (svelte-check types), and `pnpm test` (vitest over the pure engine modules).
  vitest does not type-check — keep all three green.

## Pull requests

- Keep changes in the matching vertical slice (`Source/app|audio|plugins|rackui`,
  `ui/src/features/*`) and follow the code style described in
  [AGENTS.md](AGENTS.md#code-style).
- Run `pnpm app --dist --no-run` before opening a PR — it is the same gate the
  release build uses.
- Never commit `third_party/`, `build*/`, `ui/dist/`, or any `node_modules/`.

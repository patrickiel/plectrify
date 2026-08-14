<!--
  Keep this short. The checklist is the gate from CONTRIBUTING.md, not a ritual —
  every line is something a reviewer would otherwise have to ask about.
-->

## What this changes

<!-- One or two sentences. What behaviour is different afterwards? -->

## Why

<!-- The problem, or the issue number: "Fixes #12". -->

## How it was tested

<!-- What you actually ran or played through, not what you intended to. -->

---

- [ ] `pnpm app --dist --no-run` passes — the same gate the release build uses
      (UI format/check/test, native build, CTest).
- [ ] Ran the app and exercised the change by hand, if it touches audio or UI.
- [ ] UI files formatted with `pnpm format` in `ui/` — not by hand.
- [ ] New code sits in the matching vertical slice, per
      [AGENTS.md](../AGENTS.md#code-style).
- [ ] A new UI↔engine capability is implemented in **both** `MockEngine` and
      `JuceEngine`, with its handler wired in `MainComponent`.
- [ ] `AGENTS.md` updated if this changes architecture, layout or a workflow.

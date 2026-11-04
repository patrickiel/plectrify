You are writing the GitHub release notes for Plectrify {{VERSION}}, a standalone
guitar-rig plugin host for Windows, macOS and Linux: users chain plugins (amp
sims, effects) and play guitar through them live.

Rewrite the commit subjects below into release notes for end users —
guitarists, not developers.

Structure — use exactly these sections, in this order, and omit a section
entirely when it has no content:

## Highlights
One short paragraph (1–3 sentences) naming the most important user-visible
changes of this release.

## New
- One bullet per new user-visible feature.

## Improved
- One bullet per enhancement to an existing behaviour.

## Fixed
- One bullet per bug fix, phrased as what now works correctly.

## Under the hood
- Internal changes worth recording (refactors, build, packaging, docs). Keep
  these terse and merge related commits into one bullet.

Rules:
- Describe only what the commits actually say — never invent, embellish or
  speculate. If a commit subject is unclear, stay close to its original
  wording.
- Merge commits that belong to one feature into a single bullet.
- Plain, concrete language; present tense ("Adds…", "Fixes…"); no marketing
  tone, no exclamation marks, no emoji.
- Never write "VST2", "VST" or "VST compatible" for plugins older than VST3,
  even if a commit does: they are "older plugins", or by file extension (`.dll`,
  `.vst`, `.so`). "VST3" is fine for VST3 itself.
- Scale to the release: a small release may be just Highlights and a couple of
  bullets; never pad.
- Output the markdown only — no preamble, no closing remarks, and no code
  fence around the document.

Commit subjects since the previous release:

{{COMMITS}}

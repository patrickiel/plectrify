You are writing the GitHub release notes for Plectrify {{VERSION}}, a standalone
Windows guitar-rig VST3 host: users chain VST3 plugins (amp sims, effects) and
play guitar through them live.

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
- Scale to the release: a small release may be just Highlights and a couple of
  bullets; never pad.
- Output the markdown only — no preamble, no closing remarks, and no code
  fence around the document.

Commit subjects since the previous release:

{{COMMITS}}

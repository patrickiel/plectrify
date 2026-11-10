---
title: Code signing policy
description: Who builds, reviews and signs Plectrify's Windows releases, and what gets signed.
---

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## What is signed

Only files built from this project's own source code, by the
[release workflow](https://github.com/patrickiel/plectrify/actions/workflows/release.yml) on
GitHub's servers, from a tagged commit of the
[public repository](https://github.com/patrickiel/plectrify):

- `Plectrify.exe`, the app
- `Plectrify.vst3`, the plugin for DAWs
- `Plectrify-win-x64-setup.exe`, the installer

Nothing built on a personal machine is signed. Third-party files the installer carries keep their
own makers' signatures, or none. Each of them is listed in
[THIRD_PARTY_NOTICES.md](https://github.com/patrickiel/plectrify/blob/main/THIRD_PARTY_NOTICES.md).

## Team roles

- **Committers and reviewers:**
  [Patrick Demichiel](https://github.com/patrickiel). Changes from anyone else arrive as pull
  requests and are reviewed before they are merged.
- **Approvers:** [Patrick Demichiel](https://github.com/patrickiel). Every signing request is
  approved by hand, one release at a time.

Every team member uses multi-factor authentication for GitHub and for SignPath.

## Privacy

Plectrify collects no personal data. What it sends over the network, and how to switch each part
off, is on the [privacy page](/docs/privacy).

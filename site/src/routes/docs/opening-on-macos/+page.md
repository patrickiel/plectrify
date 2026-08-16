---
title: Opening it on macOS
description: macOS may refuse the first launch and call Plectrify damaged. It is not; the build is unnotarized. Here is what that means and the two ways past it.
---

## What you will see

The first time you open Plectrify on macOS, the system may refuse it:

```
"Plectrify" is damaged and can't be opened.
You should move it to the Trash.
```

Nothing is damaged, and nothing is wrong with your download. That wording is what macOS
says about **any** app it cannot check with Apple, whatever the reason, and it is the same
sentence a genuinely corrupt file would get, which is why it is worth explaining rather than
apologising for.

## Why

Apple will vouch for an app only if its developer pays for an Apple Developer Program
membership (currently 99 USD a year) and submits each build to Apple to be _notarized_.
There is no free tier and no exemption for open-source projects.

Plectrify is written by one person and given away under the AGPL. Until there is a user base
that justifies the yearly fee, the macOS build is signed but not notarized, so Gatekeeper has
nothing from Apple to check it against and refuses it by default.

You can decide for yourself whether that is worth trusting. Two things help more than our
say-so: the [complete source](https://github.com/patrickiel/plectrify) is published for every
release, and every download is published with a SHA-256 checksum you can verify (below).

## Opening it anyway

Drag Plectrify to your **Applications** folder first. Do this before either method, because
clearing the quarantine flag applies to where the app is _now_, and moving it afterwards is
one more step to repeat.

### If macOS offers "Open Anyway"

1. Open Plectrify once and let it be refused. Click **Done** or **Cancel**.
2. Open **System Settings → Privacy & Security**.
3. Scroll to the **Security** section. A line names Plectrify as having been blocked.
4. Click **Open Anyway**, and confirm with your password or Touch ID.
5. Open Plectrify again. It launches, and never asks again.

You have to try to open it first: the button appears only after macOS has blocked something,
and it clears within the hour, so do the two steps together.

> On macOS 15 (Sequoia) and later, right-clicking the app and choosing **Open** no longer
> works as a shortcut for this. It was the standard advice for years and is still repeated all
> over the web; ignore it and use System Settings.

### If it says "damaged", or there is no Open Anyway button

Then macOS is refusing before it offers you the choice, and the quarantine flag has to be
removed directly. Open **Terminal** (Applications → Utilities) and paste:

```sh
xattr -dr com.apple.quarantine /Applications/Plectrify.app
```

Press Return. There is no output, and that means it worked. Open Plectrify normally afterwards.

That command removes the "downloaded from the internet" marker macOS attaches to files
your browser saves. It changes nothing inside the app and affects no other software.

## Verifying your download first

If you would rather check the file before running any of this, every release publishes a
checksum beside the disk image. Download `Plectrify-<version>-macos-arm64.dmg.sha256` from
the [releases page](https://github.com/patrickiel/plectrify/releases), then run:

```sh
shasum -a 256 ~/Downloads/Plectrify-<version>-macos-arm64.dmg
```

Compare the long hex string it prints with the one in the `.sha256` file. If they match, the
file you have is byte-for-byte the file that was published.

## Two things to expect afterwards

**Microphone permission comes back with each update.** macOS recognises an unnotarized app by
the exact contents of its build, so every new version looks like a new app and asks for
microphone access again. Grant it: Plectrify needs it to hear your guitar, and it records
nothing. A notarized build would keep the permission across updates.

**Nothing else changes.** Plugins, rigs, patches and your audio settings are unaffected by any
of this. It is a one-time gate on opening the app, not a limitation on running it.

## The alternative: build it yourself

Software you compile on your own machine was never downloaded, so it carries no quarantine
flag and Gatekeeper never asks. If you have Xcode Command Line Tools, CMake and Node
installed, `pnpm app --dist` produces a running build from a clone of the repository. See the
[README](https://github.com/patrickiel/plectrify#build-and-run) for the full list.

## When this goes away

The moment the project can cover the membership, macOS builds become notarized and this page
becomes history: the app will open with no warning at all. If you would like to speed that
up, the [repository](https://github.com/patrickiel/plectrify) is the place to look.

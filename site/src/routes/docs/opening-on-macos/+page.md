---
title: Opening it on macOS
description: macOS may refuse to open the Plectrify installer. Nothing is wrong with it; the build is unnotarized. Here is what that means and the two ways past it.
---

## What you will see

When you open the downloaded `Plectrify-<version>-macos-arm64.pkg`, macOS may refuse it.
The exact wording depends on your macOS version — "from an unidentified developer",
"Apple could not verify that it is free of malware", or even "damaged" — but they all mean
the same thing.

Nothing is damaged, and nothing is wrong with your download. That wording is what macOS
says about **any** installer it cannot check with Apple, whatever the reason, and it is the
same sentence a genuinely corrupt file would get, which is why it is worth explaining rather
than apologising for.

## Why

Apple will vouch for an app only if its developer pays for an Apple Developer Program
membership (currently 99 USD a year) and submits each build to Apple to be _notarized_.
There is no free tier and no exemption for open-source projects.

Plectrify is written by one person and given away under the AGPL. Until there is a user base
that justifies the yearly fee, the macOS build is not notarized, so Gatekeeper has nothing
from Apple to check it against and refuses it by default.

You can decide for yourself whether that is worth trusting. Two things help more than our
say-so: the [complete source](https://github.com/patrickiel/plectrify) is published for every
release, and every download is published with a SHA-256 checksum you can verify (below).

## Opening it anyway

The gate is on the installer alone. Once it has run, the app and the VST3 plug-in it
installed open normally — the quarantine flag belongs to the file your browser saved, and
the installer does not pass it on to what it installs.

### If macOS offers "Open Anyway"

1. Open the `.pkg` once and let it be refused. Click **Done** or **Cancel**.
2. Open **System Settings → Privacy & Security**.
3. Scroll to the **Security** section. A line names the installer as having been blocked.
4. Click **Open Anyway**, and confirm with your password or Touch ID.
5. The installer opens; click through it. You will not be asked again.

You have to try to open it first: the button appears only after macOS has blocked something,
and it clears within the hour, so do the two steps together.

> On macOS 15 (Sequoia) and later, right-clicking a file and choosing **Open** no longer
> works as a shortcut for this. It was the standard advice for years and is still repeated all
> over the web; ignore it and use System Settings.

### If there is no Open Anyway button

Then macOS is refusing before it offers you the choice, and the quarantine flag has to be
removed directly. Open **Terminal** (Applications → Utilities) and paste:

```sh
xattr -d com.apple.quarantine ~/Downloads/Plectrify-*.pkg
```

Press Return. There is no output, and that means it worked. Open the installer normally
afterwards.

That command removes the "downloaded from the internet" marker macOS attaches to files
your browser saves. It changes nothing inside the installer and affects no other software.

## Verifying your download first

If you would rather check the file before running any of this, every release publishes a
checksum beside the installer. Download `Plectrify-<version>-macos-arm64.pkg.sha256` from
the [releases page](https://github.com/patrickiel/plectrify/releases), then run:

```sh
shasum -a 256 ~/Downloads/Plectrify-<version>-macos-arm64.pkg
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

---
title: Getting started
description: Install Plectrify, choose an audio device, scan your plugins and get a sound out of it. About five minutes, most of it waiting for the plugin scan.
---

## 1. Install

Grab the build for your machine from the [download section](/#download).

- **Windows**: run the installer. It bundles the WebView2 runtime and the Visual C++
  redistributable, so there is nothing else to set up.
- **macOS** (Apple Silicon, 13.3 or newer): open the disk image and drag the app to
  Applications. The build is not notarized, so macOS refuses the first launch and may call the
  app damaged. It is not: see [Opening it on macOS](/docs/opening-on-macos), which is a
  two-minute detour you do once.

Plectrify ships **no plugins**. It is a host: you bring the amp sims and effects, and it runs
them. If you have none yet, the built-in [Packages panel](/docs/packages) can install a starter
set for you.

## 2. Choose an audio device

Open **Audio Settings** from the toolbar.

1. Pick your **device type** first. On Windows choose **ASIO** if your interface offers it;
   it is the difference between a rig you can play and one you can only hear. On macOS,
   CoreAudio is already the native low-latency path and there is nothing to choose.
2. Set your interface as the **input** and your speakers or headphones as the **output**.
3. Enable the input channel your guitar is plugged into.

Channels are listed individually, and **the first enabled input channel carries the guitar**.
It is fanned out to both sides of the rack, because a guitar is mono, so you do not need to
enable a second channel to get sound in both ears.

If you are not sure what to pick, [audio setup and latency](/docs/audio-setup) goes through it
properly.

## 3. Scan for plugins

Open **Plugins** and run a scan. Plectrify looks in the standard VST3 folders for your OS and
caches what it finds, so this is a one-off: you only need to run it again after installing
something new.

The scan runs in the background and survives a plugin that crashes on load: the offender is
blacklisted and skipped next time, and you are told which one it was. VST3 only, deliberately.

## 4. Add your first module

A **module** is one hosted plugin sitting in one slot of the rack. Add one from the picker and
it appears in the chain; add more and they run left to right, exactly like pedals on a board.

```
GUITAR IN  →  [ overdrive ]  →  [ amp sim ]  →  [ reverb ]  →  OUT
```

A sensible first chain is an amp sim on its own. Open its own editor window from the module
card, dial in a sound you like, and play.

> **No sound?** Check the master meter in the status bar. If it is moving, the problem is
> downstream: output device or volume. If it is not, the problem is upstream: input channel or
> input gain. [Troubleshooting](/docs/troubleshooting) has the rest.

## 5. Tune up

The tuner lives in the status bar and taps the input directly, so it works no matter what the
rack is doing, so you do not have to bypass anything to use it.

## 6. Save it

Two different things are worth saving, and they are not the same thing:

- A **rig** is the whole chain: every module, the order, the routing, each plugin's complete
  state. Save it under a name and recall it later. See [modules, chains and rigs](/docs/rigs).
- A **patch** is one module's knob layout plus that plugin's tone, saved so you can drop it onto
  any module running the same plugin. See [knobs and patches](/docs/patches).

You do not have to remember to save the thing you are working on: the working rack autosaves and
comes back at the next launch.

---
title: Troubleshooting
description: No sound, crackling, a plugin that will not scan, and the other walls people hit in the first hour.
---

## No sound at all

Work along the signal path in order, using the meters to tell you where it stops.

1. **Is the input meter moving when you play?** If not, the guitar is not reaching the app.
   Check the cable, the interface's own input gain, and — most often — that you enabled the
   right input channel in Audio Settings. Remember that the **first enabled input channel** is
   the one that carries the guitar.
2. **Is the master meter moving?** If the input moves and the master does not, something in the
   chain is killing the signal. Bypass modules one at a time from the left; a plugin with a
   wet/dry control at 100% wet and nothing loaded is a classic culprit.
3. **Is the master meter moving but you hear nothing?** The problem is past the app: output
   device, output gain, the master mute, or your interface's monitor knob.

An empty rack is a clean passthrough. If you hear your dry guitar with no modules loaded, the
audio path is fine and the problem is a plugin.

## Crackles, clicks and dropouts

Almost always the buffer size, and almost always under load rather than at idle.

- Raise the buffer one step and test again with your **full** rig, playing hard.
- Watch the engine load in the status bar. If it is near the ceiling, no buffer size will save
  you — the chain is too heavy for the machine and something has to come out of it.
- On Windows, confirm you are actually on **ASIO** and not on a Windows Audio device that
  happens to work.
- Convolution reverbs and high-quality amp-sim oversampling are the two costs that most often
  surprise people. Both usually have a quality setting.

See [audio setup and latency](/docs/audio-setup) for how to choose a buffer properly.

## A plugin does not show up after scanning

- Plectrify hosts **VST3 only**. VST2, AU and CLAP are not loaded — a VST2-era plugin with no
  VST3 build will never appear.
- Check the plugin actually installed to a standard VST3 folder for your OS.
- Re-run the scan. Results are cached, so a plugin installed after the last scan is not known
  until you scan again.

## A plugin crashed the scan

If a plugin crashes while being scanned, it is **blacklisted** and skipped on the next run, and
you are told which one. This is deliberate — one bad plugin should not stop you from finding the
other forty.

If you have since updated that plugin and want it retried, clear it from the blacklist and scan
again.

## A plugin's editor looks wrong or half-size

Plugin windows on high-DPI displays are a genuine mess across the whole VST3 ecosystem, and some
older plugin frameworks read the display scale exactly once while building their UI. Plectrify
carries fixes for the two common cases — a plugin drawing at half size on a scaled Windows
display, and a plugin drawing into the top-left quarter of its window on a Retina Mac.

If a plugin still misbehaves, closing and reopening its editor window is usually enough. If it is
consistently wrong, it is worth reporting — with the plugin name and version, since the fix
depends on which framework it was built with.

## Reporting a bug

**About & feedback** in the app produces a full environment report: build provenance, machine,
audio device and latency, and the plugin chain — copyable in one click. **Report a bug** opens
the issue form with that report already pasted in.

The report deliberately carries **no rig, scene or module names you typed, and no file paths**.
It describes the machine and the software, not you.

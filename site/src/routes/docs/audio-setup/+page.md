---
title: Audio setup and latency
description: Device types, buffer sizes and input gain, the settings that decide whether a rig feels like an amp or like a video call.
---

Latency is the whole game for a live rig. Everything on this page exists to get the round trip,
string to speaker, low enough that you stop noticing it, and stable enough that it never
crackles mid-song.

## Pick the right device type

On **Windows**, the device type matters more than any other setting:

| Type                                  | Use it?                                     | Why                                                                                |
| ------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| **ASIO**                              | Yes, always, if your interface has a driver | The only Windows path built for low round-trip latency.                            |
| **Windows Audio (WASAPI, exclusive)** | Workable fallback                           | Higher latency than ASIO, but usable if no ASIO driver exists.                     |
| **DirectSound / MME**                 | No                                          | Latency measured in tens of milliseconds. Fine for playback, unplayable for a rig. |

Install your interface's own ASIO driver from the manufacturer. A generic one wrapping a device
that has no native support will not beat WASAPI.

On **macOS** there is nothing to decide. CoreAudio is the native low-latency driver and your
interface talks to it directly.

## Buffer size

The buffer size is the trade you actually control: **smaller buffer, lower latency, more risk of
dropouts**. Your CPU has to render every plugin in the chain inside one buffer's worth of time,
every time, without ever being late.

A reasonable way to land on a number:

1. Start at **128 samples**.
2. Play hard for a minute with your full rig loaded, not an empty one. A heavy amp sim and a
   convolution reverb cost far more than a tuner.
3. If you hear clicks, crackles or dropouts, go up one step (256, then 512).
4. If it is clean and you want tighter feel, go down one step and repeat.

At 48 kHz, 128 samples is roughly 2.7 ms of buffering each way. 256 is about 5.3 ms. Most
players stop being able to feel the difference somewhere around 10 ms round trip.

The status bar shows the engine's live load. If it is regularly near the top, the fix is a bigger
buffer or a lighter chain, not a smaller buffer.

## Input gain and the meters

Set input gain at the interface first, and use Plectrify's input gain only for trim.

Aim for peaks well below clipping. Amp sims are built expecting a signal at roughly the level a
real pickup sends into a real amp, and a hot input does not make them sound bigger. It makes
them sound wrong, and it clips before the plugin ever gets a say. The meter turns amber as you
approach the ceiling and red when you hit it; **red means you have already lost the transient**.

## The mono fan-out

A guitar is mono, so the first enabled input channel is copied to both sides of the rack. This
happens before the first slot, which is why a stereo reverb at the end of your chain still gives
you a proper stereo image.

If you have two instruments plugged into one interface, the channel you enable first is the one
that gets played.

## Latency you cannot fix in software

Two costs sit outside the app: your interface's own converters, and any wireless system between
guitar and interface. Neither shows up in a buffer-size setting, and both are real. If the round
trip feels wrong even at a small buffer with a light chain, the interface is usually the
constraint.

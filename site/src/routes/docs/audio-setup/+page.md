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

On **Linux**, choose **JACK**. On a current desktop that is PipeWire's JACK support (the
`pipewire-jack` package), which lets Plectrify share the interface with everything else while
keeping low latency, and Plectrify finds it by itself: no `pw-jack` wrapper and no loader
configuration. **ALSA** opens the interface exclusively, so every other application on the
desktop goes silent for as long as Plectrify runs; it is the fallback for a machine with no
PipeWire and no JACK server. The section _Linux: PipeWire and JACK_ below has the two system settings worth checking.

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

## Linux: PipeWire and JACK

On a PipeWire desktop, Plectrify is one JACK client among the graph's other clients, and the
interface is driven by PipeWire itself. The buffer size you pick in Plectrify is what PipeWire
runs the graph at; the sample rate is PipeWire's and is shown rather than offered. Two things
outside the app decide whether that graph runs cleanly, and both are worth checking once. The
numbers below were measured with a Focusrite Scarlett Solo (3rd gen) and a five-module rig,
which ran clean at 64 samples after both were in place.

**Which side of a USB interface drives the clock.** PipeWire can drive a duplex interface from
its capture side or its playback side, and by default prefers capture. On a USB interface that
takes its clock from the host (Focusrite's 3rd-gen range among them) the playback side then runs
as a follower whose buffer keeps running dry, and every time it does PipeWire resyncs it, which
you hear as a click. The symptom is unmistakable in PipeWire's own log:

```
journalctl --user -u pipewire -f
spa.alsa: hw:USBp: follower avail:1 delay:1 target:384 thr:256, resync (11 suppressed)
```

The `p` after the card name says it is the playback side. The fix is one WirePlumber rule
that makes playback the driver. Find your interface's sink name with `wpctl status` (it starts
with `alsa_output.usb-`), then create
`~/.config/wireplumber/wireplumber.conf.d/51-interface-driver.conf`:

```
monitor.alsa.rules = [
  {
    matches = [ { node.name = "~alsa_output.usb-Focusrite_Scarlett.*" } ]
    actions = { update-props = { priority.driver = 2200 } }
  }
]
```

Adjust the match to your interface, then `systemctl --user restart wireplumber` and reopen the
device in Plectrify. The resync lines stop.

**PipeWire's own real-time priority.** PipeWire asks for real-time scheduling when it starts,
and on some systems it starts before the service that grants it, so its processing thread runs
at ordinary priority for the whole session. Plectrify's own audio thread is unaffected, but the
thread that wakes it is late, and the block budget shrinks by however late it was. Check with:

```
ps -L -o cls,comm -p $(pgrep -x pipewire)
```

The `data-loop.0` thread should show `RR`. If it shows `TS`, add yourself to the `pipewire`
group so the system's limits let it set the priority itself at boot (`sudo usermod -aG pipewire
$USER`, then log out and in), or for the current session
`systemctl --user restart pipewire pipewire-pulse wireplumber` and reopen the device.

**Watching it.** `pw-top` shows every node in the graph once a second; Plectrify is the
`JUCEJack` row. Its `ERR` column counts the cycles where the app's block was not ready in time,
and it should stay put while you play. If it climbs, the buffer is too small for the chain on
this machine, or one of the two settings above is still off.

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

# JUCE patches

Why each patch in this folder exists: the symptom, the plugin or machine it was
found on, and what a JUCE bump has to re-check. The rules that govern all of
them — every patch applied on every OS, `JUCE_PATCHES` in `scripts/shared.ts` as
the single declaration, how to add one, what to do after changing the JUCE tag —
are in the root [AGENTS.md](../AGENTS.md) under *Optional dependencies*. Read
the entry before touching a patch, and write one with every patch added.

- `juce-disable-webview2-zoom.patch` — 8.0.14 doesn't expose WebView2 zoom
  settings via its Options API. Windows-only file; no mac counterpart is
  needed (WKWebView ships with magnification off and the UI already
  suppresses ctrl/meta zoom keys and pinch-wheel).
- `juce-vst3-no-mac-content-scale.patch` — JUCE reports a content scale
  factor to hosted VST3s on macOS, where `IPlugViewContentScaleSupport` does
  not apply (a mac view is measured in logical points and the plugin takes
  the backing scale from its own NSWindow). JUCE sends 1.0 and merely
  swallows the failure, which is fine for a plugin that refuses it — but a
  plugin that *obeys* it loses its real 2× scale and draws its UI at half
  size in the top-left quarter of its window. Every iPlug2 build before that
  interface was guarded to Windows does obey it, Neural Amp Modeler included.
- `juce-vst3-scale-before-attach.patch` — the mirror-image problem on
  Windows/Linux. JUCE only learns the display scale through
  `NativeScaleFactorNotifier`, which reports via `MessageManager::callAsync`,
  so the real factor cannot land until after `view->attached()` — the call
  that makes a plugin build its UI — has already run against the 1.0
  placeholder. A plugin that re-reads the host's scale recovers a message
  loop later; DPF, iPlug2 and other older frameworks read it once, while
  constructing the UI, and so draw the whole editor at 1:1 for the life of
  the window (a little over half size on a 175% display). The patch asks the
  peer for the scale and reports it before attaching.
- `juce-graph-host-owned-bypass.patch` — a bypass the host requested is
  enforced by `AudioProcessorGraph` itself instead of being delegated to the
  plugin. Stock JUCE, per the VST3 contract, sets the plugin's exported
  bypass parameter (`kIsBypass`) and keeps calling `processBlock`, trusting
  the plugin to pass audio through — and a plugin whose exported parameter
  is dead (Uhhyou's OrdinaryPhaser exports one and ignores it) then never
  bypasses at all; `processBlockBypassed` is no escape, since the hosted-VST3
  override routes it back into the same parameter. The patch makes the graph
  pass the buffer through itself whenever `Node::setBypassed(true)` was
  called, skipping the plugin's processing entirely (a hard bypass — tails
  do not ring out, which is the right trade for a rig's "pedal off"). A
  plugin bypassing *itself* through its own editor is untouched.
  `Tests/audio/BypassProbe.cpp` (manual, not a CTest) is how the dead
  parameter was proven; `testBypassIsHostOwned` in the rack tests pins the
  patched behaviour so a JUCE bump that loses the patch fails CTest rather
  than shipping.
- `juce-no-double-escape-url.patch` — JUCE's mac web-view backend percent-
  encodes every URL handed to `goToURL()` with `URLQueryAllowedCharacterSet`,
  which does not contain `%`, so an escape already in the string is escaped
  again: `%3A` becomes `%253A` and the server decoding it once receives the
  literal text. The TONE3000 flow puts a URL inside a query parameter
  (`redirect_uri`), so it must be escaped and was answered with
  "redirect_uri must be a valid URL" quoting our own escapes back. The
  encoding exists to rescue a string that is *not* a valid URL, so the patch
  keeps it for exactly that case — try the string as given, escape only if
  NSURL rejects it. (Modern NSURL is lenient and encodes stray characters
  itself; the fallback is for the 13.3 floor.)
- `juce-linux-webkit-gpu.patch` — JUCE's WebKitGTK backend hard-codes
  `WEBKIT_HARDWARE_ACCELERATION_POLICY_NEVER`, so the whole UI is rasterised
  and composited on the CPU. On the same machine it ran visibly slower than
  under WebView2: every animation, and every `backdrop-filter` (the UI has
  dozens), re-rendered in software each frame. The patch asks for `ALWAYS`.
  JUCE's choice was probably a cautious one, since the view lives in a forked
  GTK child embedded over XEmbed and forced onto the X11 backend (XWayland
  on a Wayland session), and not every driver composites there. So
  `PLECTRIFY_WEBKIT_SOFTWARE_RENDERING=1` in the launch environment restores
  software rendering; the child inherits it. The policy is necessary but
  not sufficient — see the next patch.
- `juce-linux-webkit-render-device.patch` — on NVIDIA's proprietary driver
  WebKitGTK 2.52 cannot allocate its GBM buffers ("Failed to create GBM
  buffer: Invalid argument") and silently stays in non-composited software
  mode whatever the policy says: the whole page is repainted on one CPU
  thread every frame, at a cost that grows with the pixel count, so a 4K
  monitor at 166% (scale 2) is the worst case. Stock MiniBrowser does the
  same, natively on Wayland too, so neither the XEmbed embedding nor
  XWayland is the cause. A Mesa render node composites fine, so the forked
  child — before GTK starts, which keeps the `setenv` single-threaded and
  out of a DAW's environment — points `WEBKIT_WEB_RENDER_DEVICE_FILE` at the
  first accessible non-`nvidia` node when an `nvidia` one exists. A device
  the user set is left alone; an NVIDIA-only machine stays in software mode,
  since nothing on the WebKit side gets it further (forcing the DMA-BUF
  renderer there fails to import or crashes). Measured on an RTX 3060 beside
  a Radeon iGPU at scale 2: a CSS animation's web-process CPU went from ~90%
  to ~4%, ~19% with backdrop blur — and under JUCE's stock "never" it stays
  at ~71% even on the iGPU, which is why the two patches come as a pair.
- `juce-linux-webkit-persistent-cookies.patch` — JUCE never gives
  WebKitGTK's cookie manager a persistent store, and every
  `WebBrowserComponent` runs in a child process of its own, so cookies die
  with the window. The TONE3000 window is rebuilt for every fresh
  authorization (see *TONE3000* in the root `AGENTS.md`), so every tone picked asked for the
  TONE3000 password again. Options has no Linux storage location, so the
  patch reads the one `WinWebView2::withUserDataFolder` already carries for
  the same job and keeps `<folder>/cookies.sqlite` there; a browser naming no
  folder (the main UI) keeps JUCE's in-memory jar. The TONE3000 window names
  `WebKit-Tone3000` under the data root, its Linux twin of
  `WebView2-Tone3000`.
- `juce-linux-alsa-duplex-prefill.patch` — JUCE's ALSA thread starts a
  linked capture/playback pair with an empty playback buffer and paces the
  loop by capture, so every block is written exactly where the hardware is
  already reading. Its stop threshold is the boundary, so ALSA never calls
  that an xrun; the stream just stays on the edge for the life of the device.
  On a USB interface with implicit feedback (a Scarlett Solo 3rd gen, at
  128/48k) the next playback packet is queued at the instant the capture
  packet wakes the thread, so the block always loses that race: crackle from
  launch, cured only by changing the sample rate and back — a reopen that
  happened to start on a better phase, which is why it looked like a stale
  rate. `/proc/asound/card*/pcm0p/sub0/status` showed the fill at -4..0
  frames. The patch writes two periods of silence before the thread starts,
  which puts playback a full period ahead (124..254 frames, holding across a
  stall) — the callback's processing budget. One period is not enough: it
  lands back on the same race. Duplex only; an output-only loop fills its
  own buffer.
- `juce-jack-buffer-size.patch` — JUCE's JACK device offers exactly one
  buffer size (whatever the server is running) and ignores the size handed
  to `open()`, so the settings showed a single entry and the first-run 5 ms
  rule had nothing to choose from. A JACK client may ask the server for a
  block size, and PipeWire's JACK honours it (jackd changes its period for
  every client, which is what a rig wants), so the patch offers 32..2048
  plus the running size and requests the chosen one on open. The sample
  rate stays single: the JACK API has no way to ask for another, and under
  PipeWire it is the graph's. The same patch fixes the bug this was found
  through: PipeWire's JACK reports a buffer size of **0** from
  `jack_activate` until its first process cycle, and `open()` always
  deactivates and re-activates, so every reopen (a settings change, or the
  manager's own restart after launch) read the size inside that window. The
  player was prepared with a block of 0 and the manager's
  `CallbackMaxSizeEnforcer` then advanced by 0 samples forever on the audio
  thread — a full core burnt for the life of the process, no sound, and a
  crash when the device was next closed under it. The device now answers
  with the last size the server did report, never 0.
- `juce-no-zero-block-spin.patch` — the guard on the other side of that:
  `CallbackMaxSizeEnforcer` passes a block through whole when its maximum
  is 0 rather than looping, for the next backend that reports one.
- `juce-linux-webkit-versioned-sonames.patch` — JUCE 8.0.14's WebKitGTK
  backend dlopens `libwebkit2gtk-4.1.so`, `libgtk-3.so` and their
  dependencies by their **unversioned** names, which Debian and Ubuntu ship
  only in the `-dev` packages. The .deb depends on the runtime libraries
  alone, so on a machine that never built anything the backend found
  nothing, every navigation returned early, and the window stayed black
  with a clean log (issue #12). It now opens the sonames
  (`libwebkit2gtk-4.1.so.0` and friends), the names upstream JUCE switched
  to in `146fdea5` — so a JUCE bump past that commit makes this patch stop
  applying, which is the cue to keep only its other half. That half reports
  a backend that cannot start: the loader logs which library or function
  was missing (read from `dlerror()` before the failed attempt's cleanup
  `dlclose`s and so clears it), a web view process that dies during start
  is logged too, and the first navigation hands the reason to
  `WebBrowserComponent::pageLoadHadNetworkError`. `AmpWebBrowserComponent`
  paints it over the empty window — on Linux only, and only while no native
  view exists, since everywhere else that surface is what shows through a
  resize. The next way to
  land there is a distribution dropping webkit2gtk-4.1 for webkitgtk-6.0,
  which JUCE 8.0.14 does not know. Never fix this class of bug by adding a
  `-dev` package to the .deb's `Depends:`.
- `juce-vst2-speaker-arrangement-size.patch` and
  `juce-vst2-pin-properties-padding.patch` — the pair that makes JUCE's
  hosting of the older plugin format work against the FST header (see
  *Legacy plugins* in the root `AGENTS.md`). FST compiles in place of Steinberg's header, but two
  of its structs have a different `sizeof`: `VstSpeakerArrangement` ends in
  a flexible array (8 bytes, where the SDK's `speakers[8]` makes 904) and
  `VstPinProperties` omits the SDK's 48 reserved bytes (80, not 128). JUCE
  sizes its speaker-arrangement allocation from `sizeof` and puts pin
  properties on the stack, so the first real plugin loaded overran both —
  a malloc abort a few calls after `effGetSpeakerArrangement`. The first
  patch sizes the allocation from `offsetof (speakers)`, the second reads
  pin properties through a padded buffer; both compute the same thing under
  the original header. Found with `PlectrifyLegacyPluginProbe` (manual, not
  a CTest) on DPF's `.so` plugins, which memset the whole SDK-sized struct.
  Known, accepted differences that remain: `VstTimeInfo`'s two SMPTE fields
  sit at other offsets in FST, so a plugin reading SMPTE time gets zeros.
- `juce-vst2-midi-key-name-storage.patch` — the third struct of that kind:
  FST declares `MidiKeyName::keyName[]` as a flexible array, so JUCE's
  `Vst2::MidiKeyName keyName{};` in `getNameForMidiNoteNumber` holds no
  name at all. GCC and Clang accepted it and let `effGetMidiKeyName` write
  past it on the stack; MSVC refuses it outright (C2466), which is how the
  Windows build found it. It now sits at the start of a zeroed buffer with
  room for the name.
- `juce-vst2-scale-before-open.patch` — the older format's twin of
  `juce-vst3-scale-before-attach.patch`: JUCE sent a plugin declaring
  `supportsViewDpiScaling` its scale (`effVendorSpecific` `PreS`/`AeCs`)
  as 1.0 right before `effEditOpen` and the real factor a message loop
  later, so DPF plugins drew at half size on a 200% display. The format has
  no other scale channel, so a plugin that does not declare it (LSP's
  VST2 build, most Windows freeware of that era) still opens at 1:1 and
  offers its own zoom, if any.
- `juce-linux-webkit-utf8-ipc.patch` — JUCE's WebKitGTK backend talks to
  its forked view process over a pipe of JSON written as UTF-8 and read
  back with `String (const char*, n)`, which takes each byte as one
  character; the child read the page's script messages the same way. So
  every non-ASCII character was re-encoded as Latin-1 once per crossing,
  and text the page saved and read again grew a layer each time — a
  TONE3000 tone named "5150III®" ended up as a screen of `ÃÂ` (issue #48).
  Both ends now read UTF-8. What was already written stays damaged on disk,
  so the page repairs it — **once, and on Linux only**, because the repair
  (`ui/src/lib/engine/mojibake.ts`) is a heuristic: text that was never
  damaged can pass for a layer of it ("É" before a no-break space is a
  well-formed sequence), so it must not run on every read for the life of
  the app, nor at all where nothing was garbled. `JuceEngine`'s
  `repairStoredText` goes through every document the page keeps under the
  data root before the page reads any of them, rewrites the ones carrying
  the damage, and records it in `AppSettings.storedTextRepaired`; the flag
  is in settings.json so that a backup carries its own answer. The platform
  is baked into the web view's initialisation data beside `host`, since the
  decision precedes any `appInfo` push. A DAW project's session document
  cannot be reached by a pass, so the plugin's page repairs one as it reads
  it (`parseHostSession`) unless it carries the `textIntact` stamp every
  session written since carries.
- `juce-linux-webkit-clipboard.patch` — every Copy button on Linux said
  "Copy failed" (issue #55): WebKit refuses `navigator.clipboard.writeText`
  and `execCommand("copy")` with `NotAllowedError` unless the document has
  transient user activation, and a click delivered to the view inside JUCE's
  XEmbed window never grants it — instrumented in the app, the Copy handler
  ran with `navigator.userActivation.isActive` false on a secure, focused
  page. A stock WebKitGTK 2.52 window serving the same `juce://` scheme
  copies fine from a click, so the cause is the embedding, not the scheme.
  The patch turns on `javascript-can-access-clipboard`, WebKit's own bypass
  of that check (JUCE binds the symbol and never calls it), and only for a
  view with native integrations — the page the app serves itself. The
  TONE3000 window shows a third-party site and keeps the default, which is
  also what keeps that site from reading the clipboard. A JUCE bump should
  check whether clicks into the plug grant activation by now; if they do,
  the patch can go.

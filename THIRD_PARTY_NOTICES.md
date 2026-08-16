# Third-party notices

Plectrify is built with and distributes software from the following projects.

## JUCE

Plectrify and JUCE are distributed under the GNU Affero General Public License,
version 3 only (AGPL-3.0-only). The installer includes the complete AGPLv3 text
as [`LICENSE`](LICENSE) and JUCE's own notice as `JUCE_LICENSE.md`.

The pinned JUCE revision is commit
`2cdfca8feb300fb424002ba2c2751569e5bacb64` (release 8.0.14), with the patch in
`cmake/juce-disable-webview2-zoom.patch`. Every published binary release includes
a checksummed corresponding-source archive containing the tracked Plectrify source
and that exact patched JUCE source tree.

## Microsoft WebView2

The Windows installer may include Microsoft's x64 Evergreen WebView2 Runtime
Standalone Installer. The runtime is Microsoft's software and remains subject
to Microsoft's licence terms. See <https://developer.microsoft.com/microsoft-edge/webview2/>
for current distribution and licence information.

## Microsoft Visual C++ Redistributable

The Windows installer may include Microsoft's x64 Visual C++ Redistributable.
It remains subject to Microsoft's licence terms. See
<https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist>.

## Steinberg ASIO SDK

Plectrify's ASIO device support is built against the ASIO 2.3 interface headers
that Steinberg distributes with JUCE (`modules/juce_audio_devices/native/asio`).

Steinberg relicensed the ASIO SDK in October 2025 to offer a choice of the
Steinberg ASIO licence or **GPLv3**. Plectrify **elects the GPLv3 option**. That
is the only option consistent with Plectrify being AGPL-3.0-only: the proprietary
arm requires a signed agreement with Steinberg and imposes terms that AGPLv3 §7
does not permit us to pass on to you. AGPLv3 and GPLv3 are explicitly compatible
(see the FSF's GPL FAQ, "AGPLGPL"), so the headers and the rest of Plectrify
combine cleanly.

## Neural Amp Modeler (bundled)

Plectrify's installer contains one VST3 plugin: **Neural Amp Modeler**, by Steven
Atkinson, under the MIT licence. It is installed inside the application folder
(macOS: inside the app bundle), is loaded only by Plectrify, and is removed when
Plectrify is uninstalled.

It is bundled rather than offered because Plectrify's TONE3000 integration is
built on it: every tone downloaded from TONE3000 is a capture or impulse
response that this plugin plays, so shipping the browser without the player
would be shipping half a feature.

Upstream publishes no binary for the version shipped here — releases after
v0.7.13 are source-only, and the author's own Windows builds moved to a
separately-copyrighted fork with no published licence, which Plectrify therefore
cannot redistribute. Its source, and that of every one of its dependencies
(NAM Core and AudioDSPTools MIT, the VST3 SDK MIT, iPlug2 zlib-style, Eigen
MPL-2.0), is permissively licensed, so Plectrify compiles that source itself and
ships the result. What is distributed is a binary Plectrify built under a licence
that permits it, not a copy of anyone else's build.

- Project: https://github.com/sdatkinson/NeuralAmpModelerPlugin
- Source for the exact version shipped, and its licence: linked from
  `packaging/bundled-plugins.json`, which records the version, the tag and the
  SHA-256 of the archive staged into the installer.
- The upstream commit, every submodule and SDK commit, and the toolchain used
  are recorded in a `PROVENANCE-<platform>.txt` published beside that archive.
- The plugin's own third-party notices ship inside the plugin bundle.

## Other VST3 plugins

Beyond the one above, Plectrify redistributes no third-party plugin.

On explicit user action — the **Packages** panel — Plectrify can download a small
set of open-source plugins. Each is fetched over HTTPS from that project's own
release page, checked against a pinned SHA-256, and installed into the machine's
shared plugin folder (`%PROGRAMDATA%\Plectrify\plugins`; macOS:
`~/Library/Audio/Plug-Ins/VST3`). Because the transfer is from the project to
the user, each project remains the distributor of its own binaries and its own
corresponding source. Those plugins belong to the user: they are usable by any
other host and are left in place when Plectrify is uninstalled.

Every plugin remains under its own licence. The per-plugin list — what each one
is, its licence, and links to that licence and its source — is shown in the app,
in the **Packages** panel, and travels with the plugin catalogue rather than
being listed here. That is deliberate: the offered set can change without a new
Plectrify release, and a list baked into this file would go stale against the
plugins actually on offer.

## Fonts

Plectrify distributes three typefaces, all under the SIL Open Font License 1.1
(<https://openfontlicense.org>). Inter and JetBrains Mono ship as woff2 files
inside the app's web UI (and on plectrify.com); Chakra Petch is embedded in the
executable for the Windows title bar's wordmark, and its 600 cut also sets the
website's logo.

- **Inter** — Copyright 2016 The Inter Project Authors,
  <https://github.com/rsms/inter>
- **JetBrains Mono** — Copyright 2020 The JetBrains Mono Project Authors,
  <https://github.com/JetBrains/JetBrainsMono>
- **Chakra Petch** — Copyright 2018 The Chakra Petch Project Authors,
  <https://github.com/m4rc1e/Chakra-Petch>

The OFL permits bundling with software under any licence; it applies to the
font files themselves, not to Plectrify.

## ASIO drivers

Plectrify does not redistribute ASIO drivers. Users must obtain those from their
respective vendors.

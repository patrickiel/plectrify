---
title: Privacy
description: What Plectrify sends over the network, when, and how to turn each part off.
---

Plectrify has no account, collects no personal data and sends no telemetry. Your rigs, patches
and settings stay on your computer. It does not phone home, count launches or report crashes. Crash
reports are written to a folder on your own disk, and nothing leaves it unless you attach one to a
bug report yourself.

The app does use the network for a few things. This page lists every one of them.

## What happens without you asking

These are the only requests Plectrify makes by itself. On Windows, the installer shows them on its
**Select Additional Tasks** page, and two of them have a checkbox there.

- **Update check.** Once per launch, and when you open the About panel, Plectrify asks GitHub's
  public API (`api.github.com`) for the newest release. The request carries nothing but itself:
  no identifier, no version number, no headers of ours. Turn it off under **Settings → Updates**,
  or untick it in the Windows installer. **Check now** in the About panel still works when it is
  off, because then you asked.
- **Starter plugins.** On the very first launch of a fresh installation, Plectrify downloads a
  small set of free plugins so the rack has something in it. This happens once and never again.
  The files come from each plugin's own project or from `cdn.plectrify.com`. Untick it in the
  Windows installer to start with an empty drawer. The Packages panel can still install them
  later.
- **Plugin catalogue.** When it starts, Plectrify loads the list of packages the Packages panel
  offers from `cdn.plectrify.com`. It is a signed file that is downloaded, never uploaded to. If it
  cannot be reached, the app uses the copy it saved last time.

## What happens only when you ask

- **Installing a package** downloads it from the address the catalogue names: the plugin's own
  project, or `cdn.plectrify.com` for the few Plectrify hosts itself.
- **Installing an update** from inside the app, on Windows, downloads the installer from GitHub
  Releases and checks it against the hash the release publishes.
- **TONE3000.** Nothing is sent to `tone3000.com` until you open TONE3000 from the app. After that,
  Plectrify talks to TONE3000 as you, with your own sign-in, only to browse and download the tones
  you pick. Your sign-in token stays on your computer. TONE3000's own privacy
  policy covers what they do with it. A tone's photo is saved to your computer
  with the tone and shown from there, so the app does not go back to TONE3000 to display it.
- **Links** such as Discord, GitHub or a tone's page open in your normal web browser, not inside
  Plectrify.

## Other software inside Plectrify

- **Your plugins.** Plectrify runs the plugins you load inside its own process. What a plugin does
  on the network is up to that plugin and its maker, and Plectrify cannot see or stop it.
- **The web view.** Plectrify's interface is drawn by your system's web engine: Microsoft Edge
  WebView2 on Windows, WebKit on macOS and Linux. It loads Plectrify's interface from the
  computer itself, not from the internet. The engine itself is covered by its maker's privacy
  terms, for example Microsoft's [privacy statement](https://privacy.microsoft.com/privacystatement)
  for WebView2.

## This website

plectrify.com is a set of static files. It sets no cookies, runs no analytics and has no forms.

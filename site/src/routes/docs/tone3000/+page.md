---
title: Tones from TONE3000
description: Browse the TONE3000 community library from inside Plectrify and load an amp capture as an ordinary patch, with no files to find, unzip or point a plugin at.
---

[TONE3000](https://www.tone3000.com) is a community library of **amp captures** (recordings of a
real amplifier's behaviour that a plugin can play back) and impulse responses. Plectrify can browse
it and load from it directly, so a tone someone captured this morning is a couple of clicks from
your rack.

You do not need anything installed first. Neural Amp Modeler, the plugin that plays these captures,
ships with Plectrify, and captures download on demand.

## Browsing

Press **Browse TONE3000**. Plectrify opens TONE3000's own site in a window of its own, which means you
get their real catalogue: their search, their filters, their tags, and their audition players so you
can hear a capture before you take it. There is no smaller copy of their library inside Plectrify to
work around.

Sign in with your TONE3000 account the first time. The window remembers where it was: size,
position, the page you were on and how far down it you had scrolled. Closing it and coming back
puts you where you left off rather than at the top of a fresh search.

## Loading a tone

Pick a tone on their page and Plectrify takes it from there: it downloads the capture and saves it as
an **ordinary [patch](/docs/patches)**.

That is the whole design. A downloaded tone is not a special kind of object with its own panel and
its own rules. It appears in the module drawer beside your own patches, in a module's patch menu,
and it is recalled by a [rig](/docs/rigs) like anything else. Drag it onto a module and play.

Where a tone offers several models (the same capture at different sizes), Plectrify picks one for
you. They are the same amp; being asked to choose between them while holding a guitar is a question
with no useful answer.

## Credit where it is due

Every capture is somebody's work. A tone loaded from TONE3000 carries its **creator, its licence and
a link to its page**, shown on its drawer tile and in the patch menu, and it keeps them when it is
saved into a rig. The tile shows the tone's own photograph rather than a knob layout, because every
capture here is the same plugin with the same six controls, and the picture of the amp is the thing you
are actually choosing between.

A module playing a TONE3000 tone therefore arrives finished: its knobs are already mapped and its
plugin editor stays shut. Everything else about the module is yours as usual: move it, rename it,
recolour it, bypass it, or load a different patch over it.

## Where the files go

Captures and impulse responses land in a `tone3000` folder under the same shared content root the
[Packages panel](/docs/packages) uses:

|             |                                    |
| ----------- | ---------------------------------- |
| **Windows** | `%PROGRAMDATA%\Plectrify\tone3000` |
| **macOS**   | `/Users/Shared/Plectrify/tone3000` |

They are files on your disk, downloaded under your own account and TONE3000's terms. Plectrify does
not redistribute them and never bundles them into anything you export.

## Your account stays out of the web page

Plectrify's interface is a web page, and that page also hosts third-party plugin windows, so it is
deliberately never given your TONE3000 credentials. The sign-in, the token, the downloads and the
files are all handled by the app itself. The page only ever sees the finished patch.

Signing out removes the stored credential and the browser window's cookies with it.

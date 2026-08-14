---
title: Knobs and patches
description: Put the four controls you actually play in front of you, hide the two hundred you do not, and save the result as something you can re-use.
---

## The problem with plugin UIs

A serious amp sim exposes a hundred parameters or more. Perhaps six of them are things you touch
between songs, and two are things you touch during one. The rest are setup: they matter once, and
then they are noise in front of you for the rest of the gig.

Plectrify's answer is that **a module starts empty**. Nothing is surfaced until you say so.

## Mapping a knob

Open a module's mapping view and choose a parameter from the plugin. It becomes a control on the
module card, and you choose what kind:

- **Knob** — a continuous value: gain, tone, mix.
- **Switch** — an on/off or a small set of positions: bright, boost, cab on/off.
- **Meter** — read-only, for something the plugin reports rather than something you set:
  gain reduction, output level.

Then make it yours. Rename it — the plugin's `Param 47` can simply be **Grit**. Give the module
a title and an accent colour, so the amp is unmistakably the amp when you glance at the rack
mid-song.

Mapped knobs and the plugin's own editor stay in sync in both directions. Turn a dial in the
plugin's window and your mapped knob follows it, because the app polls the plugin's parameters
continuously rather than assuming it is the only one changing them.

## Patches

Once a layout is good, save it as a **patch**. A patch holds:

1. Its **name**.
2. The **plugin it was built for**.
3. The **knob mapping** — which parameters, as which control type, under which labels.
4. The **module's look** — the title override and accent colour, because those are half of what
   makes a module recognisable.
5. The **plugin's own full tone**, captured as that plugin's state.

Apply a patch to any module hosting the same plugin and you get all of it back: the layout _and_
the sound.

A patch saved without a tone — some are shipped that way deliberately — applies its mapping alone
and leaves whatever tone the module already had. That is genuinely useful: one good mapping for
your favourite amp sim, re-usable across a dozen different sounds.

## Installed patch packs

Some patches arrive with the app rather than from you. They install through the
[Packages panel](/docs/packages), and they may carry their own assets — a capture, an impulse
response — that the plugin loads.

Shipped patches are **read only**. They show a **Pack** badge, and they cannot be renamed,
edited or deleted. Making an editable version is the ordinary path and takes one step: load the
patch, then save the module under a new name. What you get is a fresh capture of the live module,
which is what you want — it includes anything you changed after loading.

## Tones downloaded from TONE3000

A capture taken from [TONE3000](/docs/tone3000) is saved as an ordinary patch too — same list, same
menu, recalled by a rig the same way. It arrives with its knobs already mapped and with its
creator's name and licence attached. See [Tones from TONE3000](/docs/tone3000).

## Why a patch is not a preset

A plugin's own preset is that plugin's tone, in that plugin's format, and it says nothing about
how you want to _play_ the thing. A patch is the tone **plus the interface you built for it**.
That is why applying one changes the module card in front of you, not just the sound coming out
of it.

> Patches were called presets in earlier versions. Anything you saved under the old name is
> migrated automatically the first time you launch a version that uses the new one — nothing to
> do and nothing lost.

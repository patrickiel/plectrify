---
title: Backing up your work
description: Save every rig, patch, song and setting to one file, carry it to another machine, and put it back.
---

Everything you make in Plectrify — your rigs, your patches, the knobs you mapped, your songs
and setlists, your MIDI bindings — lives in one folder on this computer. **Backup** puts all of
it into a single file you choose the location of, so it can go on a USB stick, into a
cloud-synced folder, or onto a second machine.

Open **Settings** in the sidebar and look for the **Backup** card.

## Making a backup

Click **Back up…**, pick where the file goes, and that is it. The file is named
`Plectrify backup <date>.plectrifybackup` by default; it is an ordinary zip, so you can open it
with any unzipping tool and see what is inside.

A line under the button tells you where it landed.

## What is in it

| In the backup | Not in the backup |
| --- | --- |
| Your saved rigs | Plugins you installed from Packages |
| Your patches, with their knob mappings and tone | Tones you downloaded from TONE3000 |
| Songs, setlists and MIDI bindings | Loop recordings |
| Preferences — theme, zoom, standby, tuner | This computer's audio device settings |

The right-hand column is deliberate rather than an oversight.

**Plugins and captures are not yours to carry in a file** — they belong to the people who made
them, and Plectrify downloads them again on the new machine. Install the same packages from the
Packages panel and sign in to TONE3000, and your restored rigs will find what they need.

**Audio settings stay with the computer.** Your interface, your buffer size and which jack the
guitar is in describe the hardware in front of you, not your playing. Restoring another
machine's audio settings would point Plectrify at a soundcard that is not there — so each
machine keeps its own, and a fresh install still gets to choose a good one for itself.

## Restoring

Click **Restore…**, confirm, and pick a backup file.

**A restore replaces everything.** Your current rigs and patches are not merged with the
backup's — they are replaced by them. That is what makes a restore predictable: afterwards the
machine holds exactly what the backup describes, with nothing left over from before.

Because there is no undoing that by hand, Plectrify saves a copy of what you have now first,
as `backup-before-restore.plectrifybackup` in its data folder:

- **Windows** — `%APPDATA%\Plectrify\`
- **macOS** — `~/Library/Application Support/Plectrify/`

If a restore turns out to be the wrong one, restore that file instead.

Plectrify reloads when the restore finishes. That is how the restored rigs and settings come
into view, and it takes a second or two.

## Moving to a new computer

1. On the old machine: **Back up…**, and put the file somewhere both machines can reach.
2. On the new one: install Plectrify, then install the same packages from **Packages**, and
   sign in to **TONE3000** if you use it.
3. **Restore…** the backup.

Do the packages before the restore rather than after, and your rigs will have their plugins
waiting when they load.

A backup made on Windows restores on a Mac and the other way round. Rigs and patches carry over
whole; the one thing that does not is a patch's link to a downloaded capture or impulse
response, because those are stored in a different place on each system. Plectrify says so when
it notices, and picking the tone again from TONE3000 repairs it.

## If something goes wrong

**"That file is not a Plectrify backup."** The file picked was not one — check the extension is
`.plectrifybackup`.

**"That backup was written by a newer version of Plectrify."** Update Plectrify on this machine
and try again. Nothing was changed.

**"There is nothing to back up yet."** Save a rig or a patch first.

Nothing is deleted until Plectrify has read the backup and found it good, so a refused restore
leaves your work exactly where it was.

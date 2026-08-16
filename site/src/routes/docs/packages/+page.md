---
title: Plugin packages
description: Install curated amps, cabs, effects and patch packs from inside the app, verified, unpacked and scanned for you.
---

Plectrify hosts _your_ plugins, but a host with nothing in it is not much use on the first
evening. The **Packages** panel offers a curated set (amp sims, cabinet impulse responses,
effects and patch packs) that install in one click.

## How an install works

1. You pick a package and press install.
2. The app downloads it and **checks its SHA-256 against a signed manifest**. A payload that does
   not match the hash is discarded, not installed.
3. Plugins unpack into the managed plugin folder; content (impulse responses, captures, patch
   packs) unpacks into a plain data folder and is never loaded as code.
4. The plugin list is refreshed, so what you installed is ready to add to the rack immediately.

Nothing needs administrator rights, and nothing is installed that you did not ask for.

## Where things land

|             | Windows                            | macOS                              |
| ----------- | ---------------------------------- | ---------------------------------- |
| **Plugins** | `%PROGRAMDATA%\Plectrify\plugins`  | `~/Library/Audio/Plug-Ins/VST3`    |
| **Content** | `%PROGRAMDATA%\Plectrify\<folder>` | `/Users/Shared/Plectrify/<folder>` |

> These folders are still named **Plectrify**, which is what the app was called before it became
> Plectrify. They will be renamed in a future release; until then, the paths above are what you
> will actually find on disk.

Both are ordinary, conventional locations that other hosts can see. A cabinet IR pack you install
here is available to every plugin on the machine, and an installed amp sim shows up in your DAW
too. These are real VST3s in a real plugin folder, not something locked inside this app.

Uninstalling Plectrify leaves both folders alone. They are your plugins.

## Dependencies

A patch pack names the one plugin it needs, so installing the patch installs that plugin first.
The reverse is not true: installing a plugin never drags in patches for it. A patch without its
plugin is meaningless; a plugin without patches is perfectly complete.

## Per-platform availability

Not every package exists for both operating systems. A package with no build for the machine you
are on is shown **greyed with install disabled**, rather than hidden, so the catalogue never
quietly looks thinner on one OS than the other, and you can tell the difference between "not
offered here" and "does not exist".

## Why the catalogue is signed

Installing a plugin means putting a binary somewhere the app will later load and execute inside
its own process. That makes the list of packages a security boundary, not a convenience: the
manifest that pins each download's hash is **cryptographically signed**, and Plectrify verifies
that signature before it acts on anything in it. The signing key is not in the app, not in the
source, and not on any build machine.

The practical consequence is that the catalogue can be updated (new plugins, new versions,
removed entries) without shipping a new version of Plectrify, and you still get the same
guarantee about what is being put on your disk.

## Licensing

Most packages are downloaded from the project that publishes them, leaving that project the
distributor. A few are re-hosted, either because the upstream release cannot simply be unzipped
into place or because no binary is published at all and it has to be built from source. Where
something is re-hosted, its licence permits it and the corresponding source is linked from the
entry.

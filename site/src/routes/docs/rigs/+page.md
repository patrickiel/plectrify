---
title: Modules, chains and rigs
description: How signal moves through the rack, adding and reordering modules, bypassing them, splitting into parallel lanes, and saving the whole thing under a name.
---

## The chain

Audio enters at the left, passes through each slot in turn, and leaves at the right:

```
GUITAR IN  →  [ slot 0 ]  →  [ slot 1 ]  →  [ slot 2 ]  →  OUT
                drive          amp sim        reverb
```

That is the entire mental model. There is no routing matrix and no send/return grid to learn,
because the thing being modelled is a pedalboard, and a pedalboard is a row.

An empty rack is a clean passthrough: you will hear your dry guitar, not silence.

## Modules

A **module** is one hosted plugin in one slot. It carries no built-in semantics: Plectrify does
not know or care whether the plugin in slot 0 calls itself an overdrive. What gives a module its
identity is what you do to it: the [knobs you surface](/docs/patches), the name you give it,
the accent colour you pick.

Each module card offers:

- **Reorder**: drag it to a different position. Signal follows the new order immediately.
- **Bypass**: the slot is routed around, not muted. A bypassed reverb stops adding tail
  instead of cutting the signal dead.
- **Remove**: takes the slot out of the chain.
- **Open editor**: opens the plugin's own UI in its own window, exactly as its authors drew it.
  Anything you change there is reflected in your mapped knobs, live.

Graph changes happen while audio is briefly suspended, which is why reordering a chain mid-song
is safe rather than a burst of noise.

## Parallel lanes

Some rigs are not a row. A **split group** fans the chain into parallel lanes that run at the
same time and sum back together before the next serial segment:

```
                    ┌─→ [ clean amp ] ──┐
GUITAR IN → [ drive ]                   ├─→ [ reverb ] → OUT
                    └─→ [ dirty amp ] ──┘
```

Each lane has its own **gain, pan, mute and solo**, so a dual-amp sound is a matter of balancing
two lanes rather than fighting one chain. A lane switch can be made exclusive, which turns the
split into an A/B, useful when the two lanes are two entire rigs and you want one at a time.

You can have as many sequential split groups as the song needs; each one closes before the next
opens.

Lane mix changes take effect without suspending audio, so riding a lane's gain is smooth.

## Rigs

A **rig** is the whole thing saved under a name: every module, the order, the split routing,
each module's knob layout, and, importantly, **each plugin's own complete binary state**. Recall
a rig and you get back the exact sound, not an approximation of it.

Saving and recalling a rig with several large plugins takes a moment: each plugin has to be
instantiated and handed its state back. The app shows progress rather than freezing.

### The working rack

You do not have to save to avoid losing work. The rack you are currently playing autosaves, and
it is restored at the next launch. Saving a rig is for the sounds you want to _return_ to, not
for the one you are in the middle of.

## Rigs versus patches

They are easy to confuse, and the distinction is worth getting right:

|               | Rig                                            | Patch                                                    |
| ------------- | ---------------------------------------------- | -------------------------------------------------------- |
| **Scope**     | The whole chain                                | One module                                               |
| **Contains**  | Every module, order, routing, all plugin state | One knob layout plus that plugin's tone                  |
| **Use it to** | Recall an entire sound for a song              | Re-apply a mapping to any module running the same plugin |

See [knobs and patches](/docs/patches) for the other half.

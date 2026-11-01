#pragma once

#include <JuceHeader.h>

#include "WindowPlacement.h"

/**
    What the TONE3000 window remembers between openings: where it was, and what
    it was showing.

    Both halves are here because both are the same kind of promise — reopen the
    window and find it as you left it — and because the interesting rule in
    either is worth testing without a screen. `place` is that rule: a saved
    rectangle is a fact about the monitors that were plugged in when it was
    saved, and restoring it blindly is how a window ends up on a display that
    has since been unplugged, or off the edge of a laptop screen that used to be
    the right-hand half of a two-monitor desk. So the saved bounds are checked
    against the displays present *now*, and a window that would come back
    unreachable is centred instead.

    The saved URL is deliberately paired with the sign-in attempt it belongs to
    (see Tone3000Service): a TONE3000 browse page is a page *inside* an OAuth
    flow, so restoring the URL without the PKCE that flow was started with would
    produce a page whose selection could never be redeemed.
*/
namespace Tone3000WindowState
{
// The placement rules are the main window's too, so they live in app/
// (WindowPlacement); these names stay so the window and its tests read as
// before.
using Bounds = plectrify::WindowPlacement::Bounds;
using plectrify::WindowPlacement::fromVar;
using plectrify::WindowPlacement::place;
using plectrify::WindowPlacement::toVar;

/** Append a line to `tone3000/window.log`, in Debug builds only.

    Every question asked about this window so far — is the size being saved? is
    it being restored? which page is it on? — has been answered by inference
    from a JSON file written minutes earlier, and twice the inference was
    wrong. Window placement is one of the few things that cannot be tested
    headlessly and cannot be observed from a terminal, so it says what it did,
    when it did it. Compiled out of Release. */
void trace (const juce::String& message);
} // namespace Tone3000WindowState

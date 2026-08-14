#pragma once

#include <JuceHeader.h>

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
/** A window's last known placement. `maximised` is stored separately from the
    rectangle, which is the un-maximised size to come back to. */
struct Bounds
{
    int x = 0, y = 0, width = 0, height = 0;
    bool maximised = false;

    /** A floor rather than "not empty", and it earns its keep twice: it rejects
        a stub size a transient layout pass could have written, and it repairs
        one already on disk — a build that saved a 128×128 teardown artefact
        would otherwise keep reopening at 128×128 for ever. */
    static constexpr int minimumSize = 320;

    bool isValid() const { return width >= minimumSize && height >= minimumSize; }
    juce::Rectangle<int> toRectangle() const { return { x, y, width, height }; }
};

juce::var toVar (const Bounds&);
Bounds fromVar (const juce::var&);

/** Where the window should actually open.

    @param saved      what was stored last time, valid or not
    @param displays   the user areas of the displays attached right now
    @param fallback   where to put a window with nothing usable saved

    A saved rectangle is accepted when enough of it lands on one display for the
    user to grab it — a fifth of its area, which is generous enough to keep a
    window deliberately straddling two monitors and strict enough to reject one
    left on a monitor that is now gone. It is then clamped to that display's
    size, since the same window may be coming back to a smaller screen. */
juce::Rectangle<int> place (const Bounds& saved,
                            const juce::Array<juce::Rectangle<int>>& displays,
                            juce::Rectangle<int> fallback);

/** Append a line to `tone3000/window.log`, in Debug builds only.

    Every question asked about this window so far — is the size being saved? is
    it being restored? which page is it on? — has been answered by inference
    from a JSON file written minutes earlier, and twice the inference was
    wrong. Window placement is one of the few things that cannot be tested
    headlessly and cannot be observed from a terminal, so it says what it did,
    when it did it. Compiled out of Release. */
void trace (const juce::String& message);
} // namespace Tone3000WindowState

#pragma once

#include <JuceHeader.h>

// Declared rather than included: the placement tests build this header against
// juce_core and juce_graphics alone.
namespace juce
{
class ResizableWindow;
}

/**
    Where a top-level window was, and where it should reopen — shared by the
    main window and the TONE3000 browser window.

    The interesting rule is `place`: a saved rectangle is a fact about the
    monitors that were plugged in when it was saved, and restoring it blindly
    is how a window ends up on a display that has since been unplugged, or off
    the edge of a laptop screen that used to be the right-hand half of a
    two-monitor desk. So the saved bounds are checked against the displays
    present *now*, and a window that would come back unreachable is centred
    instead. It is pure and tested without a screen.

    `isMaximised` / `maximiseOnceShown` exist because JUCE cannot answer the
    first on Linux. There a window under a native title bar is maximised by the
    window manager (its button, a title-bar double-click, Super+Up), and
    `LinuxComponentPeer::isFullScreen()` reports only a flag JUCE's own
    `setFullScreen()` sets — so it reads false for a window the user maximised,
    and once JUCE has set it, stays true after the user un-maximises through
    the WM. On Linux both therefore go to the window's `_NET_WM_STATE` instead
    (LinuxWindowState); elsewhere they are `isFullScreen` / `setFullScreen`.
    The same reason makes the Linux side of the restore not use
    `setFullScreen(true)` either: the flag it sets would stick.

    `toVar`/`fromVar`/`place` are pure (WindowPlacement.cpp); the rest needs a
    desktop (WindowPlacementNative.cpp). Message thread only.
*/
namespace plectrify::WindowPlacement
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

/** The user areas of the displays attached now — never under the Windows
    taskbar or the mac menu bar, where a title bar cannot be grabbed. */
juce::Array<juce::Rectangle<int>> attachedDisplays();

/** The window's bounds as a rectangle `setBounds` will put back where it is
    now — what to save. Elsewhere that is `getBounds()`; on Linux the position
    is the frame's, not the client area's: JUCE reports the client area there,
    but the window manager places a requested position at the frame's top-left
    (ICCCM's default gravity), so saving the client's would reopen the window
    one title bar lower on every launch. The size stays the client's, which is
    what `setBounds` sets. */
juce::Rectangle<int> restorableBounds (const juce::ResizableWindow&);

/** Whether the window is maximised, asked of the window system on Linux (see
    the class comment). On Windows a window minimised from maximised counts as
    maximised, since that is what restoring it gives back. False for a window
    with no peer. */
bool isMaximised (const juce::ResizableWindow&);

/** Maximises a window just made visible at its restored bounds, so that
    un-maximising it comes back to them. Immediate except on Linux, where it
    waits until the window is mapped and JUCE's first paint is behind it: that
    paint re-sends the window's bounds (juce_Windowing_linux.cpp, after
    createImage), and a window manager takes a resize request on a maximised
    window as its new un-maximised size — so maximising first, even through
    the pre-map _NET_WM_STATE, un-maximised to a size nobody chose. The window
    shows at its restored size for a frame or two first; that is the price. */
void maximiseOnceShown (juce::ResizableWindow&);
} // namespace plectrify::WindowPlacement

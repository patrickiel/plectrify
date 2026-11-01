#pragma once

/**
    A top-level X11 window's maximised state, read from and written to its
    EWMH `_NET_WM_STATE` — the window manager's own record, and the only
    reliable one: JUCE's Linux peer tracks just what its own `setFullScreen()`
    did, so a window maximised from the WM's title bar reads as not maximised
    there (see WindowPlacement).

    JUCE's XWindowSystem is not a public header, so this talks to Xlib on one
    connection of its own, opened on first use and kept; a window id is valid on
    any connection to the same server. Every call is a no-op (or false) when no
    display can be opened. Linux only; message thread only.
*/
namespace plectrify::LinuxWindowState
{
/** True when the window carries both _NET_WM_STATE_MAXIMIZED_HORZ and _VERT. */
bool isMaximised (void* nativeHandle);

/** True once the window is mapped and viewable. */
bool isViewable (void* nativeHandle);

/** Asks the window manager to maximise or restore a mapped window — the
    standard _NET_WM_STATE client message to the root window. A window not yet
    managed ignores it; see WindowPlacement::maximiseOnceShown for the wait. */
void setMaximised (void* nativeHandle, bool shouldBeMaximised);
} // namespace plectrify::LinuxWindowState

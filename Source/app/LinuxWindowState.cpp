// Deliberately without JuceHeader.h: it brings `using namespace juce`, whose
// Time, Font and Drawable collide with Xlib's typedefs of the same names.
#if defined(__linux__)

#include "LinuxWindowState.h"

#include <X11/Xatom.h>
#include <X11/Xlib.h>

#include <algorithm>
#include <cstdint>
#include <vector>

namespace plectrify::LinuxWindowState
{
namespace
{
/** One connection for the life of the process, opened on first use. These
    calls run on every move and resize of a tracked window, so a connection per
    call would be a socket round trip per pointer event during a drag. Closed
    by the OS at exit; null when no display can be opened (headless), which is
    remembered rather than retried. */
Display* sharedDisplay()
{
    static Display* const display = XOpenDisplay (nullptr);
    return display;
}

/** The atoms currently in the window's _NET_WM_STATE, empty if it has none. */
std::vector<Atom> readState (Display* display, Window window, Atom netWmState)
{
    std::vector<Atom> atoms;

    Atom actualType = None;
    int actualFormat = 0;
    unsigned long count = 0, bytesAfter = 0;
    unsigned char* data = nullptr;

    if (XGetWindowProperty (display, window, netWmState, 0, 1024, False, XA_ATOM, &actualType,
                            &actualFormat, &count, &bytesAfter, &data)
            == Success
        && data != nullptr)
    {
        // Format-32 properties come back as an array of long, whatever the
        // platform's long width — which is also what Atom is.
        if (actualType == XA_ATOM && actualFormat == 32)
        {
            const auto* values = reinterpret_cast<const Atom*> (data);
            atoms.assign (values, values + count);
        }

        XFree (data);
    }

    return atoms;
}

bool contains (const std::vector<Atom>& atoms, Atom atom)
{
    return std::find (atoms.begin(), atoms.end(), atom) != atoms.end();
}
} // namespace

bool isMaximised (void* nativeHandle)
{
    const auto window = (Window) reinterpret_cast<std::uintptr_t> (nativeHandle);
    auto* d = sharedDisplay();

    if (d == nullptr || window == 0)
        return false;

    const auto state = readState (d, window, XInternAtom (d, "_NET_WM_STATE", False));

    return contains (state, XInternAtom (d, "_NET_WM_STATE_MAXIMIZED_HORZ", False))
        && contains (state, XInternAtom (d, "_NET_WM_STATE_MAXIMIZED_VERT", False));
}

bool isViewable (void* nativeHandle)
{
    const auto window = (Window) reinterpret_cast<std::uintptr_t> (nativeHandle);
    auto* d = sharedDisplay();

    if (d == nullptr || window == 0)
        return false;

    XWindowAttributes attributes {};
    return XGetWindowAttributes (d, window, &attributes) != 0 && attributes.map_state == IsViewable;
}

void setMaximised (void* nativeHandle, bool shouldBeMaximised)
{
    const auto window = (Window) reinterpret_cast<std::uintptr_t> (nativeHandle);
    auto* d = sharedDisplay();

    if (d == nullptr || window == 0)
        return;

    XEvent event {};
    event.xclient.type = ClientMessage;
    event.xclient.window = window;
    event.xclient.message_type = XInternAtom (d, "_NET_WM_STATE", False);
    event.xclient.format = 32;
    event.xclient.data.l[0] = shouldBeMaximised ? 1 : 0; // _NET_WM_STATE_ADD / _REMOVE
    event.xclient.data.l[1] = (long) XInternAtom (d, "_NET_WM_STATE_MAXIMIZED_HORZ", False);
    event.xclient.data.l[2] = (long) XInternAtom (d, "_NET_WM_STATE_MAXIMIZED_VERT", False);
    event.xclient.data.l[3] = 1; // source: a normal application

    XSendEvent (d, DefaultRootWindow (d), False, SubstructureRedirectMask | SubstructureNotifyMask,
                &event);

    // Nothing else will flush this connection; the request must leave now.
    XFlush (d);
}
} // namespace plectrify::LinuxWindowState

#endif

#pragma once

/**
    A top-level Win32 window's maximised state, including while it is
    minimised.

    JUCE's `isFullScreen()` on Windows reads `WINDOWPLACEMENT::showCmd`, which
    is SW_SHOWMINIMIZED for a minimised window whether it was maximised before
    or not — so a maximised window minimised to the taskbar and then closed
    from there would be saved as not maximised. Windows keeps that fact in
    `WPF_RESTORETOMAXIMIZED`, which this reads (see WindowPlacement).

    Separate from WindowPlacementNative.cpp because <windows.h> and JuceHeader's
    `using namespace juce` collide (Rectangle, among others). Windows only;
    message thread only.
*/
namespace plectrify::WindowsWindowState
{
/** True when the window is maximised, or minimised from maximised (so that
    restoring it would maximise it again). */
bool isMaximised (void* nativeHandle);
} // namespace plectrify::WindowsWindowState

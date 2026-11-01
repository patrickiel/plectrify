// Deliberately without JuceHeader.h: its `using namespace juce` collides with
// <windows.h> (Rectangle, among others).
#if defined(_WIN32)

#include "WindowsWindowState.h"

#ifndef WIN32_LEAN_AND_MEAN
 #define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
 #define NOMINMAX
#endif
#include <windows.h>

namespace plectrify::WindowsWindowState
{
bool isMaximised (void* nativeHandle)
{
    const auto hwnd = static_cast<HWND> (nativeHandle);

    if (hwnd == nullptr)
        return false;

    WINDOWPLACEMENT placement {};
    placement.length = sizeof (placement);

    if (! GetWindowPlacement (hwnd, &placement))
        return false;

    if (IsIconic (hwnd))
        return (placement.flags & WPF_RESTORETOMAXIMIZED) != 0;

    return placement.showCmd == SW_SHOWMAXIMIZED;
}
} // namespace plectrify::WindowsWindowState

#endif

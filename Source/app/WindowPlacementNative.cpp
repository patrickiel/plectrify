#include "WindowPlacement.h"

#if JUCE_LINUX
 #include "LinuxWindowState.h"
#elif JUCE_WINDOWS
 #include "WindowsWindowState.h"
#endif

// The half of WindowPlacement that needs a desktop and a real window — kept
// apart so the placement tests build without juce_gui_basics.
namespace plectrify::WindowPlacement
{
juce::Array<juce::Rectangle<int>> attachedDisplays()
{
    juce::Array<juce::Rectangle<int>> areas;

    for (const auto& display : juce::Desktop::getInstance().getDisplays().displays)
        areas.add (display.userBounds.toNearestInt());

    return areas;
}

juce::Rectangle<int> restorableBounds (const juce::ResizableWindow& window)
{
    auto bounds = window.getBounds();

   #if JUCE_LINUX
    if (auto* peer = window.getPeer())
        if (const auto frame = peer->getFrameSizeIfPresent())
            bounds.translate (-frame->getLeft(), -frame->getTop());
   #endif

    return bounds;
}

bool isMaximised (const juce::ResizableWindow& window)
{
   #if JUCE_LINUX
    if (auto* peer = window.getPeer())
        return LinuxWindowState::isMaximised (peer->getNativeHandle());

    return false;
   #elif JUCE_WINDOWS
    // Not isFullScreen(): that reads false for a maximised window minimised to
    // the taskbar, which is how a window closed from there would be saved.
    if (auto* peer = window.getPeer())
        return WindowsWindowState::isMaximised (peer->getNativeHandle());

    return false;
   #else
    return window.isFullScreen();
   #endif
}
} // namespace plectrify::WindowPlacement

namespace plectrify::WindowPlacement
{
#if JUCE_LINUX
namespace
{
/** Polls until the window is viewable, lets one more tick pass for JUCE's
    first paint, then maximises it and deletes itself. Gives up after a few
    seconds rather than maximising a window at some arbitrary later moment. */
class DeferredMaximise final : private juce::Timer
{
public:
    explicit DeferredMaximise (juce::ResizableWindow& w) : window (&w) { startTimer (100); }

private:
    void timerCallback() override
    {
        auto* peer = window != nullptr ? window->getPeer() : nullptr;

        if (peer == nullptr || ++ticks > 50)
        {
            finish();
            return;
        }

        if (! LinuxWindowState::isViewable (peer->getNativeHandle()))
            return;

        if (++viewableTicks < 2)
            return;

        LinuxWindowState::setMaximised (peer->getNativeHandle(), true);
        finish();
    }

    void finish()
    {
        stopTimer();
        delete this;
    }

    juce::Component::SafePointer<juce::ResizableWindow> window;
    int ticks = 0, viewableTicks = 0;
};
} // namespace
#endif

void maximiseOnceShown (juce::ResizableWindow& window)
{
   #if JUCE_LINUX
    new DeferredMaximise (window);
   #else
    window.setFullScreen (true);
   #endif
}
} // namespace plectrify::WindowPlacement

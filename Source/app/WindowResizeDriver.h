#pragma once

#include <JuceHeader.h>

/**
    Drives an interactive window resize started from the web page's edge strips
    on platforms without a Windows-style OS sizing-loop handoff (macOS).

    Once the gesture starts, every mouse event goes to the embedded web view —
    no JUCE component ever sees a drag — so the drag is driven from a
    message-thread timer polling the global mouse position
    (Desktop::getMainMouseSource(), which queries the OS directly). Each tick
    applies ResizableBorderComponent's zone arithmetic to the bounds captured
    at the start of the gesture, routed through the window's
    ComponentBoundsConstrainer so setResizeLimits() keeps holding. The drag
    ends when the primary button is released.

    Message thread only. One drag at a time; starting a new one supersedes any
    drag still running.
*/
class WindowResizeDriver : private juce::Timer
{
public:
    /** Starts resizing the top-level window containing the given component.
        edge is a WindowResizeHandles string ("left", "top", "bottom-right",
        ...); an unknown edge starts nothing and returns false. */
    static bool start (juce::Component& componentInWindow, const juce::String& edge)
    {
        const auto flags = zoneFlagsForEdge (edge);
        auto* window = componentInWindow.getTopLevelComponent();
        if (flags == 0 || window == nullptr)
            return false;

        instance().begin (*window, juce::ResizableBorderComponent::Zone (flags));
        return true;
    }

private:
    WindowResizeDriver() = default;

    static WindowResizeDriver& instance()
    {
        static WindowResizeDriver driver;
        return driver;
    }

    void begin (juce::Component& windowToResize, juce::ResizableBorderComponent::Zone resizeZone)
    {
        window      = &windowToResize;
        zone        = resizeZone;
        startBounds = windowToResize.getBounds();
        startMouse  = juce::Desktop::getInstance().getMainMouseSource().getScreenPosition();

        constrainer = nullptr;
        if (auto* resizable = dynamic_cast<juce::ResizableWindow*> (&windowToResize))
            constrainer = resizable->getConstrainer();

        startTimerHz (60);
    }

    void timerCallback() override
    {
        // Realtime modifier state asks the OS, so button release is seen even
        // though the release event itself is delivered to the web view.
        if (window == nullptr
            || ! juce::ModifierKeys::getCurrentModifiersRealtime().isLeftButtonDown())
        {
            stopTimer();
            window = nullptr;
            return;
        }

        const auto mouse  = juce::Desktop::getInstance().getMainMouseSource().getScreenPosition();
        const auto bounds = zone.resizeRectangleBy (startBounds, (mouse - startMouse).roundToInt());

        if (constrainer != nullptr)
            constrainer->setBoundsForComponent (window, bounds,
                                                zone.isDraggingTopEdge(),
                                                zone.isDraggingLeftEdge(),
                                                zone.isDraggingBottomEdge(),
                                                zone.isDraggingRightEdge());
        else
            window->setBounds (bounds);
    }

    static int zoneFlagsForEdge (const juce::String& edge)
    {
        using Zone = juce::ResizableBorderComponent::Zone;
        int flags = 0;
        if (edge.contains ("left"))       flags |= Zone::left;
        if (edge.contains ("right"))      flags |= Zone::right;
        if (edge.startsWith ("top"))      flags |= Zone::top;
        if (edge.startsWith ("bottom"))   flags |= Zone::bottom;
        return flags;
    }

    juce::Component::SafePointer<juce::Component> window;
    juce::ResizableBorderComponent::Zone zone { 0 };
    juce::Rectangle<int> startBounds;
    juce::Point<float> startMouse;
    juce::ComponentBoundsConstrainer* constrainer = nullptr;

    JUCE_DECLARE_NON_COPYABLE (WindowResizeDriver)
};

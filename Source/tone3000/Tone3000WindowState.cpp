#include "Tone3000WindowState.h"

#include "AppPaths.h"

namespace Tone3000WindowState
{
juce::var toVar (const Bounds& bounds)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("x", bounds.x);
    o->setProperty ("y", bounds.y);
    o->setProperty ("width", bounds.width);
    o->setProperty ("height", bounds.height);
    o->setProperty ("maximised", bounds.maximised);
    return juce::var { o };
}

Bounds fromVar (const juce::var& value)
{
    Bounds bounds;
    bounds.x = (int) value.getProperty ("x", 0);
    bounds.y = (int) value.getProperty ("y", 0);
    bounds.width = (int) value.getProperty ("width", 0);
    bounds.height = (int) value.getProperty ("height", 0);
    bounds.maximised = (bool) value.getProperty ("maximised", false);
    return bounds;
}

juce::Rectangle<int> place (const Bounds& saved,
                            const juce::Array<juce::Rectangle<int>>& displays,
                            juce::Rectangle<int> fallback)
{
    if (! saved.isValid() || displays.isEmpty())
        return fallback;

    const auto wanted = saved.toRectangle();

    // The display the window overlaps most, which is the one it is "on" even
    // when it straddles two.
    juce::Rectangle<int> best;
    juce::int64 bestArea = 0;

    for (const auto& display : displays)
    {
        const auto overlap = display.getIntersection (wanted);
        const auto area = (juce::int64) overlap.getWidth() * (juce::int64) overlap.getHeight();

        if (area > bestArea)
        {
            bestArea = area;
            best = display;
        }
    }

    // A fifth of the window has to be somewhere the user can reach. Below that
    // the monitor it was saved on is gone (or has moved in the desktop's
    // coordinate space) and the saved position is not a position any more.
    const auto wantedArea = (juce::int64) wanted.getWidth() * (juce::int64) wanted.getHeight();

    if (bestArea * 5 < wantedArea)
        return fallback;

    // Same monitor, smaller screen: a window saved on a 4K display and reopened
    // on a laptop must not come back larger than the screen it is on.
    auto placed = wanted.withSize (juce::jmin (wanted.getWidth(), best.getWidth()),
                                   juce::jmin (wanted.getHeight(), best.getHeight()));

    // Re-checked after the clamp, because shrinking the window can move its far
    // edge back onto the screen but its origin can still be off it. A window
    // the user deliberately parked across two monitors passes this and is left
    // exactly where it was; one that no longer reaches its display is pulled
    // inside.
    const auto overlap = best.getIntersection (placed);
    const auto placedArea = (juce::int64) placed.getWidth() * (juce::int64) placed.getHeight();

    if ((juce::int64) overlap.getWidth() * (juce::int64) overlap.getHeight() * 5 < placedArea)
        placed = placed.constrainedWithin (best);

    return placed;
}
void trace (const juce::String& message)
{
   #if JUCE_DEBUG
    const auto file = plectrify::appDataDir().getChildFile ("tone3000").getChildFile ("window.log");
    file.getParentDirectory().createDirectory();

    // Truncated rather than rotated: this is a diagnostic for one session, and
    // an unbounded log in an app data folder is litter.
    if (file.getSize() > 256 * 1024)
        file.deleteFile();

    file.appendText (juce::Time::getCurrentTime().toString (false, true, true, true) + "  " + message
                     + juce::newLine);
   #else
    juce::ignoreUnused (message);
   #endif
}
} // namespace Tone3000WindowState

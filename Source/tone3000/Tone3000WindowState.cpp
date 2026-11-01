#include "Tone3000WindowState.h"

#include "AppPaths.h"

namespace Tone3000WindowState
{
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

#pragma once

#include <JuceHeader.h>

namespace plectrify
{
    /** Per-user Plectrify data root — %APPDATA%\Plectrify on Windows,
        ~/Library/Application Support/Plectrify on macOS (JUCE's
        userApplicationDataDirectory is bare ~/Library there).

        This tree doubles as the web page's file sandbox
        (MainComponent::resolveAppFile), so nothing that must stay out of the
        page's reach — installed plugins, install markers, the verified
        catalogue cache — may live under it.
    */
    inline juce::File appDataDir()
    {
       #if JUCE_MAC
        return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                   .getChildFile ("Application Support")
                   .getChildFile ("Plectrify");
       #else
        return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                   .getChildFile ("Plectrify");
       #endif
    }
}

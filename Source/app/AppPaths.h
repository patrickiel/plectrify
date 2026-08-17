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

    /** Where this build's read-only resources are staged — the served ui/ and
        the bundled plugins/ — resolved from the running module, so the same
        expression serves the standalone app and a VST3 plugin build.

        macOS: <bundle>/Contents/Resources. currentApplicationFile walks up
        from the Mach-O to the enclosing bundle, which inside Plectrify.vst3 is
        the plugin bundle itself, so no per-target branch is needed.

        Windows: the module's own directory for the app (resources are staged
        beside the exe). Inside a VST3 bundle the module sits at
        <bundle>/Contents/x86_64-win/, and the resources mirror the mac layout
        at the sibling Contents/Resources. currentExecutableFile resolves the
        module that contains this code (the DLL, in a plugin), never the host
        exe. */
    inline juce::File moduleResourceDir()
    {
       #if JUCE_MAC
        return juce::File::getSpecialLocation (juce::File::currentApplicationFile)
                   .getChildFile ("Contents/Resources");
       #else
        const auto moduleDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                                   .getParentDirectory();

        if (moduleDir.getFileName().equalsIgnoreCase ("x86_64-win")
            && moduleDir.getParentDirectory().getFileName().equalsIgnoreCase ("Contents"))
            return moduleDir.getParentDirectory().getChildFile ("Resources");

        return moduleDir;
       #endif
    }
}

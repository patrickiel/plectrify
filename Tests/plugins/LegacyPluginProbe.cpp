#include <JuceHeader.h>

#include <cmath>
#include <iostream>

// A manual spike, deliberately *not* registered with CTest: it loads a real
// third-party plugin into this process, which `ctest` must stay free of.
//
// It answers whether the older single-file plugin format (.dll / .vst / .so)
// is actually hosted by this build, end to end and without the app: the file
// is scanned the way PluginManager's scan would scan it, instantiated the way
// the rack would instantiate it, prepared, fed deterministic noise, and its
// name, parameters, latency and state round trip are printed. A plugin that
// yields no description here is one the drawer would never show — and the
// probe then says what PluginBinary.h would have said about it, which is the
// "Skipped plugins" reason the app would give.
//
// Usage:
//   PlectrifyLegacyPluginProbe <path to a .dll / .vst / .so / .vst3>
//
// Built only when PLECTRIFY_HOST_LEGACY_PLUGINS is ON (the format is not in
// the binary otherwise, so there would be nothing to probe).

#include "PluginBinary.h"

namespace
{
int run (const juce::File& file)
{
    juce::AudioPluginFormatManager formats;
    formats.addFormat (std::make_unique<juce::VST3PluginFormat>());
    formats.addFormat (std::make_unique<juce::VSTPluginFormat>());

    juce::OwnedArray<juce::PluginDescription> found;
    for (auto* format : formats.getFormats())
        if (format->fileMightContainThisPluginType (file.getFullPathName()))
            format->findAllTypesForFile (found, file.getFullPathName());

    if (found.isEmpty())
    {
        std::cout << "no plugin found in " << file.getFullPathName() << "\n";
        const auto reason = plectrify::pluginbinary::whyUnloadable (file);
        std::cout << "PluginBinary.h says: " << (reason.isEmpty() ? juce::String ("nothing confident (not reported)") : reason) << "\n";
        return 1;
    }

    for (auto* desc : found)
    {
        std::cout << "format:       " << desc->pluginFormatName << "\n"
                  << "name:         " << desc->name << "\n"
                  << "manufacturer: " << desc->manufacturerName << "\n"
                  << "version:      " << desc->version << "\n"
                  << "identifier:   " << desc->createIdentifierString() << "\n"
                  << "instrument:   " << (desc->isInstrument ? "yes" : "no") << "\n";

        juce::String error;
        auto instance = formats.createPluginInstance (*desc, 48000.0, 256, error);
        if (instance == nullptr)
        {
            std::cout << "instantiation failed: " << error << "\n";
            return 1;
        }

        instance->setPlayConfigDetails (2, 2, 48000.0, 256);
        instance->prepareToPlay (48000.0, 256);

        std::cout << "latency:      " << instance->getLatencySamples() << " samples\n"
                  << "parameters:   " << instance->getParameters().size() << "\n";
        int shown = 0;
        for (auto* p : instance->getParameters())
        {
            if (shown++ == 12) { std::cout << "  …\n"; break; }
            std::cout << "  [" << p->getParameterIndex() << "] " << p->getName (32)
                      << " = " << p->getCurrentValueAsText() << "\n";
        }

        juce::AudioBuffer<float> buffer (2, 256);
        juce::MidiBuffer midi;
        juce::Random random (42);
        float peakIn = 0, peakOut = 0, diff = 0;
        for (int block = 0; block < 32; ++block)
        {
            for (int ch = 0; ch < 2; ++ch)
                for (int i = 0; i < 256; ++i)
                    buffer.setSample (ch, i, random.nextFloat() * 0.5f - 0.25f);
            juce::AudioBuffer<float> in;
            in.makeCopyOf (buffer);
            instance->processBlock (buffer, midi);
            if (block < 4) continue;
            for (int ch = 0; ch < 2; ++ch)
                for (int i = 0; i < 256; ++i)
                {
                    peakIn = std::max (peakIn, std::abs (in.getSample (ch, i)));
                    peakOut = std::max (peakOut, std::abs (buffer.getSample (ch, i)));
                    diff = std::max (diff, std::abs (buffer.getSample (ch, i) - in.getSample (ch, i)));
                }
        }
        std::cout << "processed:    28 blocks; peak in " << peakIn << ", peak out " << peakOut
                  << ", max |out-in| " << diff << "\n";

        juce::MemoryBlock state;
        instance->getStateInformation (state);
        std::cout << "state:        " << state.getSize() << " bytes\n";
        instance->setStateInformation (state.getData(), (int) state.getSize());
        juce::MemoryBlock again;
        instance->getStateInformation (again);
        std::cout << "state round trip: " << (again == state ? "identical" : "differs (not necessarily wrong)") << "\n";

        std::cout << "editor:       " << (instance->hasEditor() ? "yes" : "no") << "\n";
        instance->releaseResources();
    }

    return 0;
}
} // namespace

int main (int argc, char** argv)
{
    if (argc < 2)
    {
        std::cerr << "usage: PlectrifyLegacyPluginProbe <plugin file>\n";
        return 2;
    }

    // Plugins expect a message thread, and some need one to construct.
    juce::ScopedJuceInitialiser_GUI juceInit;
    const juce::File file (juce::File::getCurrentWorkingDirectory().getChildFile (argv[1]));
    if (! file.exists())
    {
        std::cerr << "no such file: " << file.getFullPathName() << "\n";
        return 2;
    }
    return run (file);
}

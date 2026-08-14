#include <JuceHeader.h>

#include "NamStateCodec.h"

#include <iostream>

// A manual spike, deliberately *not* registered with CTest: it loads a real
// third-party VST3 into this process, which `ctest` must stay free of (plugin
// scanning in Plectrify is user-triggered, never automatic, and the offline suites
// have to run on a machine with nothing installed).
//
// It answers the one question the whole TONE3000 integration rests on, without
// a GUI session: does Neural Amp Modeler actually *accept* a state whose model
// path we rewrote, and does it load the capture at that path?
//
// The proof is in three parts:
//   1. the rewritten state is accepted by setStateInformation;
//   2. the plugin's *own* next serialisation reports the path we injected —
//      NAM only writes back what _UnserializeApplyConfig put in mNAMPath, so
//      this is the plugin agreeing, not our own bytes echoing;
//   3. processing audio through it changes the signal, which only a staged
//      model can do.
//
// It also writes the captured states to Tests/tone3000/fixtures/*.b64 so the
// offline suite gains real-world coverage. Those are our own NAM's states
// pointing at local paths — no TONE3000 content, nothing to redistribute.
//
// Usage:
//   PlectrifyNamStateProbe <path to NeuralAmpModeler.vst3> <path to a .nam> [fixture dir]

namespace
{
int failures = 0;

void check (bool condition, const juce::String& what)
{
    std::cout << (condition ? "  ok   " : "  FAIL ") << what << "\n";

    if (! condition)
        ++failures;
}

juce::String captureState (juce::AudioPluginInstance& plugin)
{
    juce::MemoryBlock block;
    plugin.getStateInformation (block);
    return juce::Base64::toBase64 (block.getData(), block.getSize());
}

void applyState (juce::AudioPluginInstance& plugin, const juce::String& base64)
{
    juce::MemoryOutputStream raw;
    juce::Base64::convertFromBase64 (raw, base64);
    plugin.setStateInformation (raw.getData(), (int) raw.getDataSize());
}

/** Root-mean-square of one block of noise pushed through the plugin. A staged
    model changes the transfer function, so this changes; an unloaded NAM is a
    near-passthrough with fixed gain. */
double rmsThroughPlugin (juce::AudioPluginInstance& plugin)
{
    constexpr int blockSize = 512;
    constexpr int blocks = 32;

    juce::AudioBuffer<float> buffer (juce::jmax (2, plugin.getTotalNumOutputChannels()), blockSize);
    juce::MidiBuffer midi;
    juce::Random random { 12345 };
    double sum = 0.0;
    int counted = 0;

    for (int b = 0; b < blocks; ++b)
    {
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
            for (int i = 0; i < blockSize; ++i)
                buffer.setSample (ch, i, (random.nextFloat() * 2.0f - 1.0f) * 0.25f);

        plugin.processBlock (buffer, midi);

        for (int i = 0; i < blockSize; ++i)
        {
            const auto s = (double) buffer.getSample (0, i);
            sum += s * s;
            ++counted;
        }
    }

    return counted > 0 ? std::sqrt (sum / (double) counted) : 0.0;
}

void writeFixture (const juce::File& dir, const juce::String& name, const juce::String& state)
{
    if (! dir.isDirectory())
        return;

    const auto file = dir.getChildFile (name + ".b64");
    file.replaceWithText (state);
    std::cout << "  wrote fixture " << file.getFullPathName() << "\n";
}
} // namespace

int main (int argc, char* argv[])
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    if (argc < 3)
    {
        std::cerr << "usage: PlectrifyNamStateProbe <NeuralAmpModeler.vst3> <capture.nam> [fixture dir]\n";
        return 2;
    }

    const juce::File pluginFile { juce::String (argv[1]) };
    const juce::File captureFile { juce::String (argv[2]) };
    const juce::File fixtureDir { argc > 3 ? juce::String (argv[3]) : juce::String() };

    if (! pluginFile.exists() || ! captureFile.existsAsFile())
    {
        std::cerr << "plugin or capture not found\n";
        return 2;
    }

    juce::AudioPluginFormatManager formats;
    formats.addFormat (new juce::VST3PluginFormat());

    juce::OwnedArray<juce::PluginDescription> found;
    juce::KnownPluginList list;

    for (auto* format : formats.getFormats())
        list.scanAndAddFile (pluginFile.getFullPathName(), true, found, *format);

    if (found.isEmpty())
    {
        std::cerr << "no plugin description found in " << pluginFile.getFullPathName() << "\n";
        return 2;
    }

    juce::String error;
    auto plugin = formats.createPluginInstance (*found[0], 48000.0, 512, error);

    if (plugin == nullptr)
    {
        std::cerr << "could not instantiate: " << error << "\n";
        return 2;
    }

    std::cout << "probing " << plugin->getName() << " " << found[0]->version << "\n";
    plugin->prepareToPlay (48000.0, 512);

    const auto factory = captureState (*plugin);
    writeFixture (fixtureDir, "nam-factory", factory);

    const auto before = NamStateCodec::read (factory);
    check (before.has_value(), "the factory state is recognised as a NAM state");

    if (! before.has_value())
        return 1;

    std::cout << "  factory nam path: '" << before->namPath << "'\n";
    std::cout << "  factory ir path:  '" << before->irPath << "'\n";

    const auto dryRms = rmsThroughPlugin (*plugin);

    const auto target = captureFile.getFullPathName();
    juce::String rewritten;
    check (NamStateCodec::rewrite (factory, target, {}, rewritten) == NamStateCodec::Result::ok,
           "the factory state rewrites to the capture's path");

    applyState (*plugin, rewritten);

    // NAM stages the model asynchronously off the message thread, so give the
    // loader a moment before asking the plugin what it thinks it has.
    for (int i = 0; i < 200; ++i)
    {
        juce::MessageManager::getInstance()->runDispatchLoopUntil (10);

        if (const auto now = NamStateCodec::read (captureState (*plugin)))
            if (now->namPath == target)
                break;
    }

    const auto after = captureState (*plugin);
    writeFixture (fixtureDir, "nam-with-model", after);

    const auto reported = NamStateCodec::read (after);
    check (reported.has_value() && reported->namPath == target,
           "the plugin serialises back the path we injected");

    const auto wetRms = rmsThroughPlugin (*plugin);
    std::cout << "  rms before " << dryRms << ", after " << wetRms << "\n";
    check (std::abs (wetRms - dryRms) > 1.0e-6, "processing changed once the model was staged");

    // Growing and shrinking the field, against the real plugin rather than a
    // synthetic chunk — the case a length-preserving substitution would hide.
    const auto longer = captureFile.getParentDirectory()
                            .getChildFile (captureFile.getFileNameWithoutExtension()
                                           + "-a-considerably-longer-name.nam");
    captureFile.copyFileTo (longer);

    juce::String grown;
    check (NamStateCodec::rewrite (after, longer.getFullPathName(), {}, grown) == NamStateCodec::Result::ok,
           "the state rewrites to a longer path");
    applyState (*plugin, grown);

    for (int i = 0; i < 200; ++i)
    {
        juce::MessageManager::getInstance()->runDispatchLoopUntil (10);

        if (const auto now = NamStateCodec::read (captureState (*plugin)))
            if (now->namPath == longer.getFullPathName())
                break;
    }

    const auto grownBack = NamStateCodec::read (captureState (*plugin));
    check (grownBack.has_value() && grownBack->namPath == longer.getFullPathName(),
           "the plugin accepted the longer path");
    longer.deleteFile();

    plugin->releaseResources();
    plugin.reset();

    if (failures != 0)
    {
        std::cerr << "NamStateProbe: " << failures << " check(s) failed\n";
        return 1;
    }

    std::cout << "NamStateProbe: the rewrite is accepted and loaded by the real plugin\n";
    return 0;
}

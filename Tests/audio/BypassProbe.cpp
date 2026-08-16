#include <JuceHeader.h>

#include <cmath>
#include <iostream>

// A manual spike, deliberately *not* registered with CTest: it loads a real
// third-party VST3 into this process, which `ctest` must stay free of.
//
// It answers one question about a hosted plugin: does bypassing it the way the
// rack does actually silence its effect? RackProcessor::setBypassed calls
// AudioProcessorGraph::Node::setBypassed, and when the plugin exports its own
// bypass parameter (VST3 kIsBypass) JUCE sets *that* and keeps calling
// processBlock, trusting the plugin to pass audio through itself. A plugin
// whose exported bypass parameter is dead therefore never bypasses at all —
// which is invisible in any offline test and very audible in a rig.
//
// The probe pushes the same deterministic noise through the plugin three ways
// and reports how far each output is from the input:
//   1. active            — should differ (the effect is running);
//   2. bypass parameter  — set to 1.0 exactly as Node::setBypassed does;
//   3. processBlockBypassed — the host-side passthrough JUCE would use if the
//      plugin exported no bypass parameter, as a reference.
//
// Usage:
//   PlectrifyBypassProbe <path to a .vst3>

namespace
{
/** Max |out - in| over `blocks` blocks of deterministic noise, skipping the
    first few blocks so smoothing and modulation have settled. The input copy
    is regenerated from the same seed, so the comparison is exact. */
double deviationFromInput (juce::AudioPluginInstance& plugin, bool useBypassedCall)
{
    constexpr int blockSize = 512;
    constexpr int blocks = 64;
    constexpr int settleBlocks = 16;

    const int channels = juce::jmax (2, plugin.getTotalNumOutputChannels(),
                                     plugin.getTotalNumInputChannels());
    juce::AudioBuffer<float> buffer (channels, blockSize);
    juce::AudioBuffer<float> input (channels, blockSize);
    juce::MidiBuffer midi;
    juce::Random random { 20260813 };
    double worst = 0.0;

    for (int b = 0; b < blocks; ++b)
    {
        for (int ch = 0; ch < channels; ++ch)
            for (int i = 0; i < blockSize; ++i)
                input.setSample (ch, i, (random.nextFloat() * 2.0f - 1.0f) * 0.25f);

        for (int ch = 0; ch < channels; ++ch)
            buffer.copyFrom (ch, 0, input, ch, 0, blockSize);

        if (useBypassedCall)
            plugin.processBlockBypassed (buffer, midi);
        else
            plugin.processBlock (buffer, midi);

        if (b < settleBlocks)
            continue;

        for (int ch = 0; ch < channels; ++ch)
            for (int i = 0; i < blockSize; ++i)
                worst = juce::jmax (worst, (double) std::abs (buffer.getSample (ch, i)
                                                              - input.getSample (ch, i)));
    }

    return worst;
}
} // namespace

int main (int argc, char* argv[])
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    if (argc < 2)
    {
        std::cerr << "usage: PlectrifyBypassProbe <plugin.vst3>\n";
        return 2;
    }

    const juce::File pluginFile { juce::String (argv[1]) };
    if (! pluginFile.exists())
    {
        std::cerr << "plugin not found: " << pluginFile.getFullPathName() << "\n";
        return 2;
    }

    juce::AudioPluginFormatManager formats;
    formats.addFormat (std::make_unique<juce::VST3PluginFormat>());

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

    auto* bypassParam = plugin->getBypassParameter();
    std::cout << "bypass parameter: "
              << (bypassParam != nullptr
                      ? ("'" + bypassParam->getName (64) + "' (index "
                         + juce::String (bypassParam->getParameterIndex()) + ")")
                      : juce::String ("none exported"))
              << "\n";

    const auto active = deviationFromInput (*plugin, false);
    std::cout << "active:                max |out-in| = " << active << "\n";

    if (bypassParam != nullptr)
    {
        // Exactly what AudioProcessorGraph::Node::setBypassed does.
        bypassParam->setValueNotifyingHost (1.0f);
        juce::MessageManager::getInstance()->runDispatchLoopUntil (50);
        std::cout << "bypass param readback: " << bypassParam->getValue() << "\n";

        const auto viaParam = deviationFromInput (*plugin, false);
        std::cout << "via bypass parameter:  max |out-in| = " << viaParam << "\n";
        std::cout << (viaParam < 1.0e-6
                          ? "-> the plugin's own bypass works\n"
                          : "-> the plugin's exported bypass parameter does NOT bypass\n");

        bypassParam->setValueNotifyingHost (0.0f);
        juce::MessageManager::getInstance()->runDispatchLoopUntil (50);
    }

    const auto viaHost = deviationFromInput (*plugin, true);
    std::cout << "processBlockBypassed:  max |out-in| = " << viaHost << "\n";

    // Control experiment: do host-driven changes to ordinary parameters reach
    // the processor at all? If nothing here changes the output either, the
    // problem is parameter delivery as a whole, not the bypass specifically.
    const auto baseline = deviationFromInput (*plugin, false);
    for (auto* param : plugin->getParameters())
    {
        if (param == bypassParam || param->getParameterIndex() > 8)
            continue;

        const auto saved = param->getValue();
        param->setValueNotifyingHost (saved < 0.5f ? 1.0f : 0.0f);
        juce::MessageManager::getInstance()->runDispatchLoopUntil (20);
        const auto moved = deviationFromInput (*plugin, false);
        std::cout << "param '" << param->getName (64) << "' flipped: max |out-in| "
                  << baseline << " -> " << moved
                  << (std::abs (moved - baseline) > 1.0e-4 ? "  (heard)" : "  (no effect)") << "\n";
        param->setValueNotifyingHost (saved);
        juce::MessageManager::getInstance()->runDispatchLoopUntil (20);
    }

    plugin->releaseResources();

    // End to end: host the plugin in an AudioProcessorGraph the way the rack
    // does, bypass the *node*, and check the graph output equals the input.
    // This is what the PLECTRIFY_HOST_OWNED_BYPASS JUCE patch fixes; unpatched
    // JUCE keeps the plugin audibly processing here.
    {
        juce::AudioProcessorGraph graph;
        // Config first: the IO processors take their channel counts from the
        // graph's layout, and addConnection refuses a channel that does not
        // exist yet.
        graph.setPlayConfigDetails (2, 2, 48000.0, 512);

        using IO = juce::AudioProcessorGraph::AudioGraphIOProcessor;
        auto inNode = graph.addNode (std::make_unique<IO> (IO::audioInputNode));
        auto outNode = graph.addNode (std::make_unique<IO> (IO::audioOutputNode));
        auto pluginNode = graph.addNode (std::move (plugin));

        for (int ch = 0; ch < 2; ++ch)
        {
            if (! graph.addConnection ({ { inNode->nodeID, ch }, { pluginNode->nodeID, ch } })
                || ! graph.addConnection ({ { pluginNode->nodeID, ch }, { outNode->nodeID, ch } }))
                std::cout << "graph: connection refused on channel " << ch << "\n";
        }

        graph.prepareToPlay (48000.0, 512);

        juce::AudioBuffer<float> buffer (2, 512);
        juce::AudioBuffer<float> input (2, 512);
        juce::MidiBuffer midi;
        juce::Random random { 424242 };
        const auto worstThroughGraph = [&]
        {
            double worst = 0.0;
            for (int b = 0; b < 64; ++b)
            {
                for (int ch = 0; ch < 2; ++ch)
                    for (int i = 0; i < 512; ++i)
                        input.setSample (ch, i, (random.nextFloat() * 2.0f - 1.0f) * 0.25f);
                for (int ch = 0; ch < 2; ++ch)
                    buffer.copyFrom (ch, 0, input, ch, 0, 512);
                graph.processBlock (buffer, midi);
                if (b < 16)
                    continue;
                for (int ch = 0; ch < 2; ++ch)
                    for (int i = 0; i < 512; ++i)
                        worst = juce::jmax (worst, (double) std::abs (buffer.getSample (ch, i)
                                                                      - input.getSample (ch, i)));
            }
            return worst;
        };

        const auto graphActive = worstThroughGraph();
        pluginNode->setBypassed (true);
        const auto graphBypassed = worstThroughGraph();
        std::cout << "graph node active:     max |out-in| = " << graphActive << "\n";
        std::cout << "graph node bypassed:   max |out-in| = " << graphBypassed << "\n";
        std::cout << (graphBypassed < 1.0e-6
                          ? "-> host-owned bypass passes through\n"
                          : "-> node bypass is NOT passing through\n");
        graph.releaseResources();
    }

    return 0;
}

#include "PluginProcessor.h"
#include "PluginEditor.h"

#include <algorithm>
#include <vector>

PlectrifyAudioProcessor::PlectrifyAudioProcessor()
    : juce::AudioProcessor (BusesProperties()
          .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
          .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    engine = std::make_unique<PlectrifyEngine> (*this);

    // The host hands us whole track buffers; which channel carries the guitar
    // is answered by the DAW's own routing, so the router always taps channel
    // 0 — the DI on a stereo track, the only channel on a mono one (the
    // graph's render-time clamp covers that case).
    engine->getRack().setInputSourceChannel (0);

    // The engine ticks headless from day one: latency publication (and, in a
    // later phase, the host-state capture cache) must not wait for an editor
    // to be opened.
    engine->startTicking();
}

PlectrifyAudioProcessor::~PlectrifyAudioProcessor()
{
    // The host destroys every editor before the processor, so no web view can
    // still be attached here; the engine tears down its own windows.
    engine.reset();
}

// ---------------------------------------------------------------------------
// The AudioProcessorPlayer's old job.
// ---------------------------------------------------------------------------
void PlectrifyAudioProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    preparedSampleRate.store (sampleRate);
    preparedBlockSize.store (samplesPerBlock);

    // The graph's outer layout is fixed at 2-in/2-out (the router fans the
    // chosen input channel onto both); a mono host bus is adapted in
    // processBlock, where the wrapper's buffer already carries the output
    // channel count.
    auto& graph = engine->getRack().getGraph();
    graph.setPlayConfigDetails (2, 2, sampleRate, samplesPerBlock);
    graph.prepareToPlay (sampleRate, samplesPerBlock);
}

void PlectrifyAudioProcessor::releaseResources()
{
    engine->getRack().getGraph().releaseResources();
}

bool PlectrifyAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    // A guitar track is mono or stereo; the rig always renders stereo (pan on
    // split lanes is meaningless into a mono output).
    const auto in  = layouts.getMainInputChannelSet();
    const auto out = layouts.getMainOutputChannelSet();

    return (in == juce::AudioChannelSet::mono() || in == juce::AudioChannelSet::stereo())
        && out == juce::AudioChannelSet::stereo();
}

void PlectrifyAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer,
                                            juce::MidiBuffer& midiMessages)
{
    juce::ScopedNoDenormals noDenormals;

    // Host MIDI, reduced to the three trigger-capable kinds the page acts on
    // (see MidiInputManager's contract) and queued lock-free for the engine
    // tick to flush. The rack graph itself has no MIDI node, so nothing else
    // reads the buffer.
    for (const auto metadata : midiMessages)
    {
        const auto message = metadata.getMessage();
        HostMidiEvent event {};

        if (message.isController())
            event = { 0, (juce::uint8) message.getChannel(),
                      (juce::uint8) message.getControllerNumber(),
                      (juce::uint8) message.getControllerValue() };
        else if (message.isProgramChange())
            event = { 1, (juce::uint8) message.getChannel(),
                      (juce::uint8) message.getProgramChangeNumber(), 0 };
        else if (message.isNoteOn()) // velocity > 0 only; note-offs never trigger
            event = { 2, (juce::uint8) message.getChannel(),
                      (juce::uint8) message.getNoteNumber(),
                      (juce::uint8) message.getVelocity() };
        else
            continue;

        const auto scope = hostMidiFifo.write (1);
        if (scope.blockSize1 > 0)
            hostMidiEvents[scope.startIndex1] = event;
        // A full FIFO drops the event: trigger MIDI, not a recorded stream.
    }

    auto& graph = engine->getRack().getGraph();

    // The player's suspension contract, replicated: topology edits happen on
    // the message thread with the graph suspended, and the audio thread hands
    // back silence rather than running a half-built render sequence.
    const juce::ScopedLock lock (graph.getCallbackLock());

    if (graph.isSuspended())
    {
        buffer.clear();
        return;
    }

    // On a mono track the buffer still has two channels (the output bus is
    // stereo) and the second may hold garbage on input. Nothing routes it:
    // the router taps only the chosen input pin, so no clear is needed.
    graph.processBlock (buffer, midiMessages);
}

juce::AudioProcessorEditor* PlectrifyAudioProcessor::createEditor()
{
    return new PlectrifyAudioProcessorEditor (*this);
}

// ---------------------------------------------------------------------------
// Host-saved state: the engine's one JSON document, raw UTF-8 in the block.
// ---------------------------------------------------------------------------
void PlectrifyAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    const auto json = engine->currentHostState();
    juce::MemoryOutputStream out (destData, false);
    out.write (json.toRawUTF8(), json.getNumBytesAsUTF8());
}

void PlectrifyAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (data == nullptr || sizeInBytes <= 0)
        return;

    const juce::String json = juce::String::fromUTF8 (static_cast<const char*> (data), sizeInBytes);
    if (json.trim().isEmpty())
        return;

    // Applying rebuilds the rack (async plugin creation on the message
    // thread), and some hosts restore state from a loader thread — marshal
    // rather than assume. The engine's load generation makes the latest
    // arrival win over one still applying.
    juce::WeakReference<PlectrifyEngine> safe (engine.get());
    auto apply = [safe, json]
    {
        if (safe != nullptr)
            safe->applyHostState (json);
    };

    if (juce::MessageManager::getInstance()->isThisTheMessageThread())
        apply();
    else
        juce::MessageManager::callAsync (std::move (apply));
}

// ---------------------------------------------------------------------------
// HostServices — the DAW-hosted answers.
// ---------------------------------------------------------------------------
plectrify::HostCapabilities PlectrifyAudioProcessor::capabilities() const
{
    plectrify::HostCapabilities caps;
    caps.audioDevices = false;   // the DAW owns the device
    caps.midiDevices  = false;   // MIDI arrives from the host track
    caps.windowChrome = false;   // the DAW owns the window
    caps.autoStandby  = false;   // suspension is the host's business
    return caps;
}

std::pair<double, int> PlectrifyAudioProcessor::currentRateAndBlock() const
{
    const auto rate  = preparedSampleRate.load();
    const auto block = preparedBlockSize.load();

    if (rate > 0.0 && block > 0)
        return { rate, block };

    // Before the first prepareToPlay (a DAW restoring a project instantiates
    // plugins before it starts the transport): the same defaults the
    // standalone uses with no device open. The graph re-prepares everything at
    // the real values when they arrive.
    return { 44100.0, 512 };
}

void PlectrifyAudioProcessor::graphLatencyChanged (int totalLatencySamples)
{
    // Message thread — the engine publishes from its 15 Hz timer. JUCE's VST3
    // wrapper forwards the change to the host, whose delay compensation then
    // tracks the chain.
    setLatencySamples (totalLatencySamples);
}

void PlectrifyAudioProcessor::engineSettingsChanged()
{
    // A fixed-node setting (or the page's session document) moved: the DAW
    // project now differs from the last saved state, and updateHostDisplay is
    // how the host learns to mark it dirty.
    engine->markHostStateDirty();
    updateHostDisplay();
}

void PlectrifyAudioProcessor::handleSetEditorSize (const juce::var& payload)
{
    // Same clamps as the host-state restore of editor.width/height: the
    // page's grip already limits itself, but a size that authorises window
    // geometry is validated where it is applied, not where it was typed.
    const auto width  = juce::jlimit (760, 32768, static_cast<int> (payload.getProperty ("width",  0)));
    const auto height = juce::jlimit (480, 32768, static_cast<int> (payload.getProperty ("height", 0)));

    // Bridge events arrive on the message thread; the wrapper turns setSize
    // into a host-window resize (resizeHostWindow in the AU client, onSize in
    // the VST3's), and resized() writes the result back onto the engine.
    if (auto* editor = getActiveEditor())
        editor->setSize (width, height);
}

void PlectrifyAudioProcessor::onEngineTick()
{
    // Drain and coalesce exactly as MidiInputManager::handleIncomingMidiMessage
    // does: a CC replaces the newest pending value for the same controller,
    // but only while both sit on the same side of the UI's press threshold
    // (MIDI_PRESS_THRESHOLD in ui/src/lib/engine/midi.ts) — a swept pedal
    // coalesces to its latest position while a quick press+release inside one
    // tick keeps both edges.
    constexpr int pressThreshold = 64;
    static const char* const kindNames[] = { "cc", "pc", "note" };

    std::vector<HostMidiEvent> batch;
    const auto scope = hostMidiFifo.read (hostMidiFifo.getNumReady());
    for (int i = 0; i < scope.blockSize1; ++i)
        batch.push_back (hostMidiEvents[scope.startIndex1 + i]);
    for (int i = 0; i < scope.blockSize2; ++i)
        batch.push_back (hostMidiEvents[scope.startIndex2 + i]);

    if (batch.empty())
        return;

    std::vector<HostMidiEvent> coalesced;
    for (const auto& event : batch)
    {
        if (event.kind == 0)
        {
            const auto newest = std::find_if (coalesced.rbegin(), coalesced.rend(),
                                              [&] (const HostMidiEvent& p)
                                              {
                                                  return p.kind == 0
                                                      && p.channel == event.channel
                                                      && p.number == event.number;
                                              });
            if (newest != coalesced.rend()
                && (newest->value >= pressThreshold) == (event.value >= pressThreshold))
            {
                newest->value = event.value;
                continue;
            }
        }
        coalesced.push_back (event);
    }

    juce::Array<juce::var> events;
    for (const auto& event : coalesced)
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("type", juce::String (kindNames[event.kind]));
        object->setProperty ("channel", (int) event.channel);
        object->setProperty ("number", (int) event.number);
        object->setProperty ("value", (int) event.value);
        events.add (juce::var (object));
    }

    engine->emit ("midiEvents", juce::var (std::move (events)));
}

// This is what the VST3 wrapper calls to create the plugin.
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new PlectrifyAudioProcessor();
}

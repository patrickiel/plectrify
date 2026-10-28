#include "NamPluginProcessor.h"
#include "NamPluginEditor.h"

#include "NAM/activations.h"
#include "NAM/get_dsp.h"

#include <filesystem>

namespace
{
const char* const stateMarker = "###NeuralAmpModeler###"; // iPlug2 NAM's, verbatim
constexpr double dcBlockerFrequency = 5.0;                 // upstream's kDCBlockerFrequency
constexpr double normalizedLoudnessTarget = -18.0;         // upstream's targetLoudness

double dbToAmp (double db) { return std::pow (10.0, db / 20.0); }

/** One iPlug2 IByteChunk::PutStr field: an int32 byte count, then the bytes,
    no terminator. Little-endian, as every platform Plectrify ships on is. */
void putString (juce::MemoryOutputStream& out, const juce::String& text)
{
    const auto* utf8 = text.toRawUTF8();
    const auto length = (int) std::strlen (utf8);
    out.writeInt (length);
    out.write (utf8, (size_t) length);
}

bool getString (juce::MemoryInputStream& in, juce::String& result)
{
    if (in.getNumBytesRemaining() < 4)
        return false;
    const auto length = in.readInt();
    if (length < 0 || length > in.getNumBytesRemaining())
        return false;
    juce::MemoryBlock bytes;
    in.readIntoMemoryBlock (bytes, length);
    result = juce::String::fromUTF8 ((const char*) bytes.getData(), length);
    return true;
}
} // namespace

NamPluginProcessor::NamPluginProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    nam::activations::Activation::enable_fast_tanh();

    // Upstream's EParams order, names and ranges (NeuralAmpModeler.cpp, v0.7.15),
    // after the Bypass iPlug2 exports first. The order *is* the interface: knob
    // mappings address parameters by index.
    addParameter (bypass = new juce::AudioParameterBool ({ "bypass", 1 }, "Bypass", false));
    addParameter (inputLevel = new juce::AudioParameterFloat ({ "input", 1 }, "Input",
        juce::NormalisableRange<float> (-20.0f, 20.0f, 0.1f), 0.0f, juce::AudioParameterFloatAttributes().withLabel ("dB")));
    addParameter (noiseGateThreshold = new juce::AudioParameterFloat ({ "threshold", 1 }, "Threshold",
        juce::NormalisableRange<float> (-100.0f, 0.0f, 0.1f), -80.0f, juce::AudioParameterFloatAttributes().withLabel ("dB")));
    addParameter (toneBass = new juce::AudioParameterFloat ({ "bass", 1 }, "Bass",
        juce::NormalisableRange<float> (0.0f, 10.0f, 0.1f), 5.0f));
    addParameter (toneMid = new juce::AudioParameterFloat ({ "middle", 1 }, "Middle",
        juce::NormalisableRange<float> (0.0f, 10.0f, 0.1f), 5.0f));
    addParameter (toneTreble = new juce::AudioParameterFloat ({ "treble", 1 }, "Treble",
        juce::NormalisableRange<float> (0.0f, 10.0f, 0.1f), 5.0f));
    addParameter (outputLevel = new juce::AudioParameterFloat ({ "output", 1 }, "Output",
        juce::NormalisableRange<float> (-40.0f, 40.0f, 0.1f), 0.0f, juce::AudioParameterFloatAttributes().withLabel ("dB")));
    addParameter (noiseGateActive = new juce::AudioParameterBool ({ "noiseGateActive", 1 }, "NoiseGateActive", true));
    addParameter (eqActive = new juce::AudioParameterBool ({ "toneStack", 1 }, "ToneStack", true));
    addParameter (irToggle = new juce::AudioParameterBool ({ "irToggle", 1 }, "IRToggle", true));
    addParameter (calibrateInput = new juce::AudioParameterBool ({ "calibrateInput", 1 }, "CalibrateInput", false));
    addParameter (inputCalibrationLevel = new juce::AudioParameterFloat ({ "inputCalibrationLevel", 1 }, "InputCalibrationLevel",
        juce::NormalisableRange<float> (-60.0f, 60.0f, 0.1f), 12.0f, juce::AudioParameterFloatAttributes().withLabel ("dBu")));
    addParameter (outputMode = new juce::AudioParameterChoice ({ "outputMode", 1 }, "OutputMode",
        juce::StringArray { "Raw", "Normalized", "Calibrated" }, 1));
    addParameter (slim = new juce::AudioParameterFloat ({ "slim", 1 }, "Slim",
        juce::NormalisableRange<float> (0.0f, 1.0f, 0.01f), 0.0f));

    stateParameters = { inputLevel, noiseGateThreshold, toneBass, toneMid, toneTreble, outputLevel,
                        noiseGateActive, eqActive, irToggle, calibrateInput, inputCalibrationLevel,
                        outputMode, slim };

    toneStack = std::make_unique<dsp::tone_stack::BasicNamToneStack>();
    noiseGateTrigger.AddListener (&noiseGateGain);

    startTimerHz (10);
}

NamPluginProcessor::~NamPluginProcessor()
{
    stopTimer();
}

bool NamPluginProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    // Upstream's PLUG_CHANNEL_IO "1-1 1-2 2-2": mono or stereo either side,
    // but never stereo in to mono out.
    const auto in = layouts.getMainInputChannelSet();
    const auto out = layouts.getMainOutputChannelSet();
    const auto monoOrStereo = [] (const juce::AudioChannelSet& set)
    { return set == juce::AudioChannelSet::mono() || set == juce::AudioChannelSet::stereo(); };

    return monoOrStereo (in) && monoOrStereo (out) && in.size() <= out.size();
}

void NamPluginProcessor::prepareToPlay (double sampleRate, int maximumExpectedSamplesPerBlock)
{
    currentSampleRate = sampleRate;
    currentBlockSize = juce::jmax (1, maximumExpectedSamplesPerBlock);

    inputBuffer.assign ((size_t) currentBlockSize, 0.0);
    outputBuffer.assign ((size_t) currentBlockSize, 0.0);
    inputPointers[0] = inputBuffer.data();
    outputPointers[0] = outputBuffer.data();

    // Processing is suspended here, so the live objects are ours to touch.
    const juce::SpinLock::ScopedLockType lock (stagingLock);

    for (auto* m : { model.get(), stagedModel.get() })
        if (m != nullptr)
            m->Reset (sampleRate, currentBlockSize);

    // An IR is resampled by rebuilding it from its own data at the new rate.
    for (auto* ir : { &impulseResponse, &stagedIr })
        if (*ir != nullptr && ! juce::approximatelyEqual ((*ir)->GetSampleRate(), sampleRate))
            *ir = std::make_unique<dsp::ImpulseResponse> ((*ir)->GetData(), sampleRate);

    toneStack->Reset (sampleRate, currentBlockSize);
    lastBass = lastMid = lastTreble = -1.0f;   // force the stack to refresh
    highPass.SetParams (recursive_linear_filter::HighPassParams (sampleRate, dcBlockerFrequency));

    liveLatency = model != nullptr ? model->getLatency() : 0;
    setLatencySamples (liveLatency);
}

double NamPluginProcessor::getTailLengthSeconds() const
{
    // Upstream's: ten cycles of the DC blocker's decay; the model and IR are
    // ignored there too.
    return 10.0 / dcBlockerFrequency;
}

void NamPluginProcessor::applyStaging()
{
    const juce::SpinLock::ScopedTryLockType lock (stagingLock);
    if (! lock.isLocked())
        return;

    if ((removeModel || stagedModel != nullptr) && retiredModel == nullptr)
    {
        retiredModel = std::move (model);
        model = std::move (stagedModel);   // null when this was a removal
        removeModel = false;
        liveLatency = model != nullptr ? model->getLatency() : 0;
    }

    if ((removeIr || stagedIr != nullptr) && retiredIr == nullptr)
    {
        retiredIr = std::move (impulseResponse);
        impulseResponse = std::move (stagedIr);
        removeIr = false;
    }
}

void NamPluginProcessor::updateGains() noexcept
{
    auto inputDb = (double) inputLevel->get();
    if (model != nullptr && model->HasInputLevel() && calibrateInput->get())
        inputDb += (double) inputCalibrationLevel->get() - model->GetInputLevel();
    inputGain = dbToAmp (inputDb);

    auto outputDb = (double) outputLevel->get();
    if (model != nullptr)
    {
        switch (outputMode->getIndex())
        {
            case 1: // Normalized
                if (model->HasLoudness())
                    outputDb += normalizedLoudnessTarget - model->GetLoudness();
                break;
            case 2: // Calibrated
                if (model->HasOutputLevel())
                    outputDb += model->GetOutputLevel() - (double) inputCalibrationLevel->get();
                break;
            default: break; // Raw
        }
    }
    outputGain = dbToAmp (outputDb);
}

void NamPluginProcessor::updateToneStack() noexcept
{
    const auto refresh = [this] (float& last, float now, const char* name)
    {
        if (juce::exactlyEqual (last, now))
            return;
        last = now;
        toneStack->SetParam (name, (double) now);
    };

    refresh (lastBass, toneBass->get(), "bass");
    refresh (lastMid, toneMid->get(), "middle");
    refresh (lastTreble, toneTreble->get(), "treble");
}

void NamPluginProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    const juce::ScopedNoDenormals noDenormals;

    applyStaging();
    updateGains();
    updateToneStack();

    if (model != nullptr)
        if (auto* slimmable = model->getSlimmableModel())
            slimmable->SetSlimmableSize ((double) slim->get());

    const auto numIn = getTotalNumInputChannels();
    const auto numOut = buffer.getNumChannels();
    const auto gateOn = noiseGateActive->get();
    const auto eqOn = eqActive->get();
    const auto irOn = irToggle->get() && impulseResponse != nullptr;

    if (gateOn)
    {
        // Upstream's fixed gate shape; only the threshold is a parameter.
        noiseGateTrigger.SetParams (dsp::noise_gate::TriggerParams (
            0.01, (double) noiseGateThreshold->get(), 0.1, 0.005, 0.01, 0.05));
        noiseGateTrigger.SetSampleRate (currentSampleRate);
    }

    // In chunks no larger than prepareToPlay promised the model.
    for (int start = 0; start < buffer.getNumSamples(); start += currentBlockSize)
    {
        const auto frames = juce::jmin (currentBlockSize, buffer.getNumSamples() - start);
        const auto numFrames = (size_t) frames;

        // Mono in: the average of what arrives, as upstream does inside a DAW
        // (a stereo track carrying one guitar would otherwise come in 6 dB hot).
        const auto gain = inputGain / juce::jmax (1, numIn);
        for (int s = 0; s < frames; ++s)
        {
            double sum = 0.0;
            for (int c = 0; c < numIn; ++c)
                sum += (double) buffer.getSample (c, start + s);
            inputBuffer[(size_t) s] = gain * sum;
        }

        double** stage = inputPointers;
        if (gateOn)
            stage = noiseGateTrigger.Process (stage, 1, numFrames);

        if (model != nullptr)
            model->process (stage, outputPointers, frames);
        else
            std::copy (stage[0], stage[0] + frames, outputPointers[0]);

        stage = outputPointers;
        if (gateOn)
            stage = noiseGateGain.Process (stage, 1, numFrames);
        if (eqOn)
            stage = toneStack->Process (stage, 1, frames);
        if (irOn)
            stage = impulseResponse->Process (stage, 1, numFrames);
        stage = highPass.Process (stage, 1, numFrames);

        // Mono out, broadcast to every output channel.
        for (int c = 0; c < numOut; ++c)
            for (int s = 0; s < frames; ++s)
                buffer.setSample (c, start + s, (float) (outputGain * stage[0][s]));
    }
}

void NamPluginProcessor::timerCallback()
{
    // Free what the audio thread retired — the one place it is safe to.
    {
        const juce::SpinLock::ScopedLockType lock (stagingLock);
        retiredModel.reset();
        retiredIr.reset();
    }

    if (getLatencySamples() != liveLatency.load())
        setLatencySamples (liveLatency.load());
}

// ---------------------------------------------------------------------------
// Model and IR
// ---------------------------------------------------------------------------
juce::String NamPluginProcessor::loadModel (const juce::File& file)
{
    try
    {
        auto dsp = nam::get_dsp (std::filesystem::u8path (file.getFullPathName().toStdString()));

        if (dsp->NumInputChannels() != 1 || dsp->NumOutputChannels() != 1)
            return "A model must have one input and one output channel.";

        auto staged = std::make_unique<plectrify::nam_plugin::ResamplingNam> (std::move (dsp), currentSampleRate);
        staged->Reset (currentSampleRate, currentBlockSize);
        if (auto* slimmable = staged->getSlimmableModel())
            slimmable->SetSlimmableSize ((double) slim->get());

        {
            const juce::SpinLock::ScopedLockType lock (stagingLock);
            stagedModel = std::move (staged);
            removeModel = false;
        }
        const juce::ScopedLock pl (pathLock);
        modelPath = file.getFullPathName();
        return {};
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
}

juce::String NamPluginProcessor::loadImpulseResponse (const juce::File& file)
{
    try
    {
        auto staged = std::make_unique<dsp::ImpulseResponse> (
            file.getFullPathName().toRawUTF8(), currentSampleRate);

        if (staged->GetWavState() != dsp::wav::LoadReturnCode::SUCCESS)
            return "That file could not be read as a WAV impulse response.";

        {
            const juce::SpinLock::ScopedLockType lock (stagingLock);
            stagedIr = std::move (staged);
            removeIr = false;
        }
        const juce::ScopedLock pl (pathLock);
        irPath = file.getFullPathName();
        return {};
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
}

void NamPluginProcessor::clearModel()
{
    {
        const juce::SpinLock::ScopedLockType lock (stagingLock);
        stagedModel.reset();
        removeModel = true;
    }
    const juce::ScopedLock pl (pathLock);
    modelPath.clear();
}

void NamPluginProcessor::clearImpulseResponse()
{
    {
        const juce::SpinLock::ScopedLockType lock (stagingLock);
        stagedIr.reset();
        removeIr = true;
    }
    const juce::ScopedLock pl (pathLock);
    irPath.clear();
}

juce::String NamPluginProcessor::getModelPath() const
{
    const juce::ScopedLock pl (pathLock);
    return modelPath;
}

juce::String NamPluginProcessor::getImpulseResponsePath() const
{
    const juce::ScopedLock pl (pathLock);
    return irPath;
}

// ---------------------------------------------------------------------------
// State — iPlug2 NAM's SerializeState layout, byte for byte.
// ---------------------------------------------------------------------------
void NamPluginProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::MemoryOutputStream out (destData, false);
    putString (out, stateMarker);
    putString (out, stateVersion);
    putString (out, getModelPath());
    putString (out, getImpulseResponsePath());

    // iPlug2's SerializeParams: each parameter's plain value as a double.
    for (auto* p : stateParameters)
        out.writeDouble ((double) p->convertFrom0to1 (p->getValue()));
}

void NamPluginProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    juce::MemoryInputStream in (data, (size_t) sizeInBytes, false);

    juce::String marker, version, namPath, impulsePath;
    if (! getString (in, marker) || marker != stateMarker
        || ! getString (in, version) || ! getString (in, namPath) || ! getString (in, impulsePath))
        return;   // not a NAM state: leave everything as it is

    for (auto* p : stateParameters)
    {
        if (in.getNumBytesRemaining() < (juce::int64) sizeof (double))
            break;   // an older layout with fewer parameters keeps the rest at default
        p->setValueNotifyingHost (p->convertTo0to1 ((float) in.readDouble()));
    }

    // Like upstream: a path that no longer loads leaves that slot empty.
    if (namPath.isEmpty() || loadModel (juce::File (namPath)).isNotEmpty())
        clearModel();
    if (impulsePath.isEmpty() || loadImpulseResponse (juce::File (impulsePath)).isNotEmpty())
        clearImpulseResponse();
}

juce::AudioProcessorEditor* NamPluginProcessor::createEditor()
{
    return new NamPluginEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new NamPluginProcessor();
}

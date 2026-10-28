#pragma once

#include <JuceHeader.h>

#include <atomic>
#include <memory>
#include <vector>

#include "ResamplingNam.h"
#include "ToneStack.h"
#include "dsp/ImpulseResponse.h"
#include "dsp/NoiseGate.h"
#include "dsp/RecursiveLinearFilter.h"

/**
    Neural Amp Modeler for Linux: NAM's own DSP (NeuralAmpModelerCore and
    AudioDSPTools, at the commits NAM v0.7.15 pins) in a JUCE VST3, because the
    upstream plugin is built on iPlug2, which has no Linux target.

    It is built to be *indistinguishable from upstream to Plectrify*, and that is
    the whole design:

      - the same plugin name, "NeuralAmpModeler", which is what patches, the
        drawer and the TONE3000 slice find it by (the manufacturer is Plectrify
        and the VST3 class id is its own, so no host confuses the two);
      - the same parameters in the same order, with Bypass first exactly as
        iPlug2 exports it — so the TONE3000 knob template's indices (1 = Input
        … 6 = Output) mean the same knobs on every OS;
      - the same state layout iPlug2's SerializeState writes (marker, version,
        model path, IR path, then every parameter as a double), so
        NamStateCodec rewrites a capture into it with no second code path.

    The audio chain is upstream's, stage for stage: input gain (with optional
    input calibration) → noise-gate trigger → model (resampled to the capture's
    own rate) → gate gain → tone stack → IR → 5 Hz DC blocker → output gain
    (raw, loudness-normalized or calibrated).

    Threading. Models and IRs are loaded off the audio thread and *staged*; the
    audio thread swaps a staged object in under a try-lock and moves the one it
    replaced into a retired slot, which a message-thread timer frees — so the
    audio thread never allocates or deletes. Paths are guarded by their own lock
    because hosts may ask for state from any thread.
*/
class NamPluginProcessor final : public juce::AudioProcessor,
                                 private juce::Timer
{
public:
    NamPluginProcessor();
    ~NamPluginProcessor() override;

    // --- AudioProcessor ----------------------------------------------------
    void prepareToPlay (double sampleRate, int maximumExpectedSamplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "NeuralAmpModeler"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override;

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    juce::AudioProcessorParameter* getBypassParameter() const override { return bypass; }

    // --- Model and IR ------------------------------------------------------
    /** Load a .nam capture. Returns an empty string on success, otherwise why
        it failed (the previous model stays). Any thread but the audio one. */
    juce::String loadModel (const juce::File& file);
    /** Load a cabinet IR (.wav). Same contract as loadModel. */
    juce::String loadImpulseResponse (const juce::File& file);
    void clearModel();
    void clearImpulseResponse();

    juce::String getModelPath() const;
    juce::String getImpulseResponsePath() const;

    /** The parameter layout's version string, written into the state where
        iPlug2's NAM writes PLUG_VERSION_STR. It names the upstream release whose
        parameter list this one mirrors — that is what a reader of the state
        needs to know, not how this wrapper is versioned. */
    static constexpr const char* stateVersion = "0.7.15";

private:
    using ResamplingNamPtr = std::unique_ptr<plectrify::nam_plugin::ResamplingNam>;
    using IrPtr = std::unique_ptr<dsp::ImpulseResponse>;

    void timerCallback() override;

    /** Apply whatever is staged, if the lock is free and the retired slots are
        empty. Audio thread only. */
    void applyStaging();
    /** Input and output gain from the parameters and the live model's
        calibration data — upstream's _SetInputGain/_SetOutputGain. */
    void updateGains() noexcept;
    void updateToneStack() noexcept;

    // --- Parameters, in upstream's order (Bypass first, as iPlug2 exports it).
    juce::AudioParameterBool* bypass = nullptr;
    juce::AudioParameterFloat* inputLevel = nullptr;
    juce::AudioParameterFloat* noiseGateThreshold = nullptr;
    juce::AudioParameterFloat* toneBass = nullptr;
    juce::AudioParameterFloat* toneMid = nullptr;
    juce::AudioParameterFloat* toneTreble = nullptr;
    juce::AudioParameterFloat* outputLevel = nullptr;
    juce::AudioParameterBool* noiseGateActive = nullptr;
    juce::AudioParameterBool* eqActive = nullptr;
    juce::AudioParameterBool* irToggle = nullptr;
    juce::AudioParameterBool* calibrateInput = nullptr;
    juce::AudioParameterFloat* inputCalibrationLevel = nullptr;
    juce::AudioParameterChoice* outputMode = nullptr;
    juce::AudioParameterFloat* slim = nullptr;

    /** Every serialised parameter, in state order (Bypass excluded — iPlug2
        does not count it among the plugin's own parameters either). */
    juce::Array<juce::RangedAudioParameter*> stateParameters;

    // --- DSP, owned by the audio thread once prepared.
    ResamplingNamPtr model;
    IrPtr impulseResponse;
    std::unique_ptr<dsp::tone_stack::BasicNamToneStack> toneStack;
    dsp::noise_gate::Trigger noiseGateTrigger;
    dsp::noise_gate::Gain noiseGateGain;
    recursive_linear_filter::HighPass highPass;

    std::vector<double> inputBuffer, outputBuffer;
    double* inputPointers[1] {};
    double* outputPointers[1] {};

    double inputGain = 1.0, outputGain = 1.0;
    float lastBass = -1.0f, lastMid = -1.0f, lastTreble = -1.0f;

    // --- Staging between loader threads and the audio thread.
    juce::SpinLock stagingLock;
    ResamplingNamPtr stagedModel, retiredModel;
    IrPtr stagedIr, retiredIr;
    bool removeModel = false, removeIr = false;

    mutable juce::CriticalSection pathLock;
    juce::String modelPath, irPath;

    std::atomic<int> liveLatency { 0 };
    double currentSampleRate = 48000.0;
    int currentBlockSize = 512;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NamPluginProcessor)
};

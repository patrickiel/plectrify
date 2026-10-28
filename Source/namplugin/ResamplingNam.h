// Adapted from Neural Amp Modeler v0.7.15 (NeuralAmpModeler/NeuralAmpModeler.h:
// GetNAMSampleRate and class ResamplingNAM), MIT License, Copyright (c) 2023
// Steven Atkinson — see THIRD_PARTY_NOTICES.md. Unchanged apart from naming the
// file and namespace; the resampler is what lets a 48 kHz capture play at
// whatever rate the host runs.
#pragma once

#include <cmath>
#include <functional>
#include <memory>
#include <stdexcept>

#include "NAM/dsp.h"
#include "NAM/slimmable.h"

// AudioDSPTools' resampler was lifted out of iPlug2 and still reads two of its
// constants. These are iPlug2's own values (IPlugConstants.h), defined here
// because this build has no iPlug2 to take them from.
#ifndef DEFAULT_BLOCK_SIZE
 #define DEFAULT_BLOCK_SIZE 1024
#endif
namespace iplug
{
static constexpr double PI = 3.1415926535897932384626433832795;
}

#include "dsp/ResamplingContainer/ResamplingContainer.h"

namespace plectrify::nam_plugin
{
// Some models are from when NAM did not record a sample rate; those are
// assumed to be 48 kHz, which is how almost all of them were trained.
inline double getNamSampleRate (const std::unique_ptr<nam::DSP>& model)
{
    const double assumedSampleRate = 48000.0;
    const double reported = model->GetExpectedSampleRate();
    return reported <= 0.0 ? assumedSampleRate : reported;
}

class ResamplingNam : public nam::DSP
{
public:
    ResamplingNam (std::unique_ptr<nam::DSP> encapsulated, const double expectedSampleRate)
        : nam::DSP (encapsulated->NumInputChannels(), encapsulated->NumOutputChannels(), expectedSampleRate),
          mEncapsulated (std::move (encapsulated)),
          mResampler (getNamSampleRate (mEncapsulated))
    {
        mBlockProcessFunc = [this] (NAM_SAMPLE** input, NAM_SAMPLE** output, int numFrames)
        { mEncapsulated->process (input, output, numFrames); };

        if (mEncapsulated->HasLoudness())
            SetLoudness (mEncapsulated->GetLoudness());
        if (mEncapsulated->HasInputLevel())
            SetInputLevel (mEncapsulated->GetInputLevel());
        if (mEncapsulated->HasOutputLevel())
            SetOutputLevel (mEncapsulated->GetOutputLevel());

        const int maxBlockSize = 2048; // conservative, as upstream
        Reset (expectedSampleRate, maxBlockSize);
    }

    void prewarm() override { mEncapsulated->prewarm(); }

    void process (NAM_SAMPLE** input, NAM_SAMPLE** output, const int numFrames) override
    {
        if (numFrames > mMaxExternalBlockSize)
            throw std::runtime_error ("More frames were provided than the max expected!");

        if (! needToResample())
            mEncapsulated->process (input, output, numFrames);
        else
            mResampler.ProcessBlock (input, output, numFrames, mBlockProcessFunc);
    }

    int getLatency() const { return needToResample() ? mResampler.GetLatency() : 0; }

    void Reset (const double sampleRate, const int maxBlockSize) override
    {
        mExpectedSampleRate = sampleRate;
        mMaxExternalBlockSize = maxBlockSize;
        mResampler.Reset (sampleRate, maxBlockSize);

        const double upRatio = sampleRate / getEncapsulatedSampleRate();
        const auto maxEncapsulatedBlockSize =
            static_cast<int> (std::ceil (static_cast<double> (maxBlockSize) / upRatio));
        mEncapsulated->ResetAndPrewarm (sampleRate, maxEncapsulatedBlockSize);
    }

    double getEncapsulatedSampleRate() const { return getNamSampleRate (mEncapsulated); }

    nam::SlimmableModel* getSlimmableModel() { return dynamic_cast<nam::SlimmableModel*> (mEncapsulated.get()); }

private:
    bool needToResample() const { return GetExpectedSampleRate() != getEncapsulatedSampleRate(); }

    std::unique_ptr<nam::DSP> mEncapsulated;
    dsp::ResamplingContainer<NAM_SAMPLE, 1, 12> mResampler;
    int mMaxExternalBlockSize = 0;
    std::function<void (NAM_SAMPLE**, NAM_SAMPLE**, int)> mBlockProcessFunc;
};
} // namespace plectrify::nam_plugin

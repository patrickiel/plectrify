#include "TunerDetector.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace
{
constexpr float minimumRms = 0.0005623413f; // -65 dBFS
constexpr float minimumConfidence = 0.80f;
constexpr int framesToConfirmNote = 3;
constexpr int framesToClearReading = 6;

float frequencyForMidiNote (int midiNote) noexcept
{
    return 440.0f * std::pow (2.0f, (float) (midiNote - 69) / 12.0f);
}

float centsFromReference (float frequency, float reference) noexcept
{
    return 1200.0f * std::log2 (frequency / reference);
}

float medianOfThree (std::array<float, 3> values) noexcept
{
    std::sort (values.begin(), values.end());
    return values[1];
}
}

TunerDetector::TunerDetector()
    : juce::Thread ("Plectrify tuner")
{
}

TunerDetector::~TunerDetector()
{
    release();
}

void TunerDetector::prepare (double sourceSampleRate)
{
    release();

    sourceRate = juce::jmax (8000.0, sourceSampleRate);
    highPass.setCoefficients (juce::IIRCoefficients::makeHighPass (sourceRate, 20.0));
    lowPassA.setCoefficients (juce::IIRCoefficients::makeLowPass (sourceRate, 2500.0));
    lowPassB.setCoefficients (juce::IIRCoefficients::makeLowPass (sourceRate, 2500.0));
    resetAnalysisState();
    startThread (juce::Thread::Priority::normal);
}

void TunerDetector::release()
{
    signalThreadShouldExit();
    stopThread (1000);
    fifo.reset();
    publishUndetected();
}

void TunerDetector::setEnabled (bool shouldBeEnabled) noexcept
{
    enabled.store (shouldBeEnabled, std::memory_order_release);
    resetRequested.store (true, std::memory_order_release);

    if (! shouldBeEnabled)
        publishUndetected();
}

void TunerDetector::pushSamples (const float* samples, int count) noexcept
{
    if (! enabled.load (std::memory_order_acquire) || samples == nullptr || count <= 0)
        return;

    int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
    fifo.prepareToWrite (count, start1, size1, start2, size2);

    if (size1 > 0)
        juce::FloatVectorOperations::copy (fifoSamples.data() + start1, samples, size1);
    if (size2 > 0)
        juce::FloatVectorOperations::copy (fifoSamples.data() + start2, samples + size1, size2);

    fifo.finishedWrite (size1 + size2);
}

TunerReading TunerDetector::getReading() const
{
    const juce::ScopedLock lock (readingLock);
    return reading;
}

void TunerDetector::run()
{
    while (! threadShouldExit())
    {
        if (resetRequested.exchange (false, std::memory_order_acq_rel))
        {
            // Discard queued pre-toggle audio through the reader side rather
            // than resetting both FIFO indices while the producer may run.
            int discardStart1 = 0, discardSize1 = 0, discardStart2 = 0, discardSize2 = 0;
            fifo.prepareToRead (fifo.getNumReady(), discardStart1, discardSize1,
                                discardStart2, discardSize2);
            fifo.finishedRead (discardSize1 + discardSize2);
            resetAnalysisState();
        }

        int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
        fifo.prepareToRead (workerBlockSize, start1, size1, start2, size2);

        if (size1 + size2 == 0)
        {
            wait (5);
            continue;
        }

        if (size1 > 0)
            juce::FloatVectorOperations::copy (workerSamples.data(), fifoSamples.data() + start1, size1);
        if (size2 > 0)
            juce::FloatVectorOperations::copy (workerSamples.data() + size1, fifoSamples.data() + start2, size2);

        fifo.finishedRead (size1 + size2);

        if (enabled.load (std::memory_order_acquire))
            processSourceSamples (workerSamples.data(), size1 + size2);
    }
}

void TunerDetector::resetAnalysisState()
{
    highPass.reset();
    lowPassA.reset();
    lowPassB.reset();
    nextOutputSourcePosition = 0.0;
    sourceSamplePosition = 0;
    hasPreviousFilteredSample = false;
    previousFilteredSample = 0.0f;
    analysisRing.fill (0.0f);
    analysisWritePosition = 0;
    analysisSamplesCollected = 0;
    samplesSinceAnalysis = 0;
    stableMidiNote = -1;
    pendingMidiNote = -1;
    pendingNoteFrames = 0;
    invalidFrames = 0;
    recentCents.fill (0.0f);
    recentCentsCount = 0;
    recentCentsPosition = 0;
    lastConfidence = 0.0f;
    publishUndetected();
}

void TunerDetector::processSourceSamples (const float* samples, int count)
{
    const auto sourceSamplesPerOutput = sourceRate / analysisSampleRate;

    for (int i = 0; i < count; ++i)
    {
        auto filtered = highPass.processSingleSampleRaw (samples[i]);
        filtered = lowPassA.processSingleSampleRaw (filtered);
        filtered = lowPassB.processSingleSampleRaw (filtered);

        const auto currentPosition = (double) sourceSamplePosition;
        if (hasPreviousFilteredSample)
        {
            while (nextOutputSourcePosition <= currentPosition)
            {
                const auto fraction = (float) juce::jlimit (0.0, 1.0,
                    nextOutputSourcePosition - (currentPosition - 1.0));
                acceptAnalysisSample (previousFilteredSample
                    + fraction * (filtered - previousFilteredSample));
                nextOutputSourcePosition += sourceSamplesPerOutput;
            }
        }
        else
        {
            nextOutputSourcePosition = currentPosition + sourceSamplesPerOutput;
            hasPreviousFilteredSample = true;
        }

        previousFilteredSample = filtered;
        ++sourceSamplePosition;
    }
}

void TunerDetector::acceptAnalysisSample (float sample)
{
    analysisRing[(size_t) analysisWritePosition] = sample;
    analysisWritePosition = (analysisWritePosition + 1) % frameSize;
    analysisSamplesCollected = juce::jmin (frameSize, analysisSamplesCollected + 1);

    if (analysisSamplesCollected < frameSize)
        return;

    if (++samplesSinceAnalysis < hopSize)
        return;

    samplesSinceAnalysis = 0;
    analyseFrame();
}

void TunerDetector::analyseFrame()
{
    for (int i = 0; i < frameSize; ++i)
        orderedFrame[(size_t) i] = analysisRing[(size_t) ((analysisWritePosition + i) % frameSize)];

    double energy = 0.0;
    for (const auto sample : orderedFrame)
        energy += (double) sample * sample;

    const auto rms = (float) std::sqrt (energy / frameSize);
    if (rms < minimumRms)
    {
        acceptInvalidFrame();
        return;
    }

    difference.fill (0.0f);
    normalisedDifference.fill (1.0f);

    for (int lag = 1; lag <= maximumLag; ++lag)
    {
        double sum = 0.0;
        for (int i = 0; i < comparisonLength; ++i)
        {
            const auto delta = orderedFrame[(size_t) i] - orderedFrame[(size_t) (i + lag)];
            sum += (double) delta * delta;
        }
        difference[(size_t) lag] = (float) sum;
    }

    double cumulative = 0.0;
    for (int lag = 1; lag <= maximumLag; ++lag)
    {
        cumulative += difference[(size_t) lag];
        normalisedDifference[(size_t) lag] = cumulative > 0.0
            ? (float) (difference[(size_t) lag] * lag / cumulative)
            : 1.0f;
    }

    std::vector<Candidate> candidates;
    candidates.reserve (16);

    for (int thresholdIndex = 0; thresholdIndex <= 15; ++thresholdIndex)
    {
        const auto threshold = 0.05f + 0.01f * thresholdIndex;
        int chosenLag = 0;

        for (int lag = minimumLag; lag < maximumLag; ++lag)
        {
            if (normalisedDifference[(size_t) lag] < threshold)
            {
                chosenLag = lag;
                while (chosenLag + 1 <= maximumLag
                       && normalisedDifference[(size_t) (chosenLag + 1)]
                            < normalisedDifference[(size_t) chosenLag])
                    ++chosenLag;
                break;
            }
        }

        if (chosenLag == 0)
            continue;

        auto existing = std::find_if (candidates.begin(), candidates.end(), [chosenLag] (const Candidate& item)
        {
            return std::abs (item.lag - chosenLag) <= 1;
        });

        const auto confidence = 1.0f - normalisedDifference[(size_t) chosenLag];
        if (existing == candidates.end())
            candidates.push_back ({ chosenLag, 1, confidence });
        else
        {
            ++existing->votes;
            existing->confidence = juce::jmax (existing->confidence, confidence);
        }
    }

    if (candidates.empty())
    {
        acceptInvalidFrame();
        return;
    }

    const auto best = std::max_element (candidates.begin(), candidates.end(), [] (const Candidate& a, const Candidate& b)
    {
        if (a.votes != b.votes)
            return a.votes < b.votes;
        return a.confidence < b.confidence;
    });

    if (best->confidence < minimumConfidence)
    {
        acceptInvalidFrame();
        return;
    }

    auto refinedLag = (float) best->lag;
    if (best->lag > 1 && best->lag < maximumLag)
    {
        // The cumulative normalization is excellent for choosing the correct
        // trough but slightly skews its shape. Refine against the raw
        // difference curve for more accurate sub-sample periods.
        const auto left = difference[(size_t) (best->lag - 1)];
        const auto centre = difference[(size_t) best->lag];
        const auto right = difference[(size_t) (best->lag + 1)];
        const auto denominator = left - 2.0f * centre + right;
        if (std::abs (denominator) > 1.0e-8f)
            refinedLag += juce::jlimit (-1.0f, 1.0f, 0.5f * (left - right) / denominator);
    }

    const auto frequency = (float) analysisSampleRate / refinedLag;
    if (frequency < minimumFrequency || frequency > maximumFrequency)
    {
        acceptInvalidFrame();
        return;
    }

    acceptCandidate (frequency, best->confidence);
}

void TunerDetector::acceptCandidate (float frequencyHz, float confidence)
{
    invalidFrames = 0;
    auto candidateMidi = juce::roundToInt (69.0f + 12.0f * std::log2 (frequencyHz / 440.0f));

    if (stableMidiNote >= 0)
    {
        const auto centsFromStable = centsFromReference (frequencyHz, frequencyForMidiNote (stableMidiNote));
        if (std::abs (centsFromStable) <= 55.0f)
            candidateMidi = stableMidiNote;
    }

    if (candidateMidi != stableMidiNote)
    {
        if (pendingMidiNote != candidateMidi)
        {
            pendingMidiNote = candidateMidi;
            pendingNoteFrames = 1;
        }
        else
        {
            ++pendingNoteFrames;
        }

        if (pendingNoteFrames < framesToConfirmNote)
            return;

        stableMidiNote = candidateMidi;
        pendingMidiNote = -1;
        pendingNoteFrames = 0;
        recentCentsCount = 0;
        recentCentsPosition = 0;
    }
    else
    {
        pendingMidiNote = -1;
        pendingNoteFrames = 0;
    }

    const auto cents = centsFromReference (frequencyHz, frequencyForMidiNote (stableMidiNote));
    recentCents[(size_t) recentCentsPosition] = cents;
    recentCentsPosition = (recentCentsPosition + 1) % (int) recentCents.size();
    recentCentsCount = juce::jmin ((int) recentCents.size(), recentCentsCount + 1);
    lastConfidence = confidence;

    auto stableCents = cents;
    if (recentCentsCount == 3)
        stableCents = medianOfThree (recentCents);
    else if (recentCentsCount == 2)
        stableCents = 0.5f * (recentCents[0] + recentCents[1]);

    const auto stableFrequency = frequencyForMidiNote (stableMidiNote)
        * std::pow (2.0f, stableCents / 1200.0f);
    publish ({ true, stableFrequency, stableMidiNote, stableCents, lastConfidence });
}

void TunerDetector::acceptInvalidFrame()
{
    if (++invalidFrames >= framesToClearReading)
    {
        stableMidiNote = -1;
        pendingMidiNote = -1;
        pendingNoteFrames = 0;
        recentCentsCount = 0;
        publishUndetected();
    }
}

void TunerDetector::publish (const TunerReading& next)
{
    const juce::ScopedLock lock (readingLock);
    reading = next;
}

void TunerDetector::publishUndetected()
{
    publish ({});
}

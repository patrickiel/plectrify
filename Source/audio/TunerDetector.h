#pragma once

#include <JuceHeader.h>

#include <array>
#include <atomic>

/** A coherent pitch estimate produced by TunerDetector. The frequency and
    cents fields are meaningful only while detected is true. */
struct TunerReading
{
    bool detected = false;
    float frequencyHz = 0.0f;
    int midiNote = 0;
    float cents = 0.0f;
    float confidence = 0.0f;
};

/** Real-time-safe front end and background pitch analyser for guitar and
    bass input.

    The audio thread only writes samples to a preallocated SPSC FIFO. A worker
    thread removes DC, low-pass filters, resamples to a fixed analysis rate,
    and runs a multi-threshold YIN detector with note stabilisation. Reading
    the latest result is safe from the message thread and never touches the
    audio callback's FIFO state.
*/
class TunerDetector final : private juce::Thread
{
public:
    TunerDetector();
    ~TunerDetector() override;

    void prepare (double sourceSampleRate);
    void release();
    void setEnabled (bool shouldBeEnabled) noexcept;
    bool isEnabled() const noexcept { return enabled.load (std::memory_order_relaxed); }

    /** Called from the audio thread. Never allocates or blocks. */
    void pushSamples (const float* samples, int count) noexcept;

    /** Called from the message thread. */
    TunerReading getReading() const;

private:
    static constexpr int fifoCapacity = 65536;
    static constexpr int workerBlockSize = 4096;
    static constexpr double analysisSampleRate = 16000.0;
    static constexpr int frameSize = 2048;
    static constexpr int hopSize = 256;
    static constexpr float minimumFrequency = 30.0f;
    static constexpr float maximumFrequency = 1320.0f;
    static constexpr int minimumLag = 12;
    static constexpr int maximumLag = 534;
    static constexpr int comparisonLength = frameSize - maximumLag;

    struct Candidate
    {
        int lag = 0;
        int votes = 0;
        float confidence = 0.0f;
    };

    void run() override;
    void resetAnalysisState();
    void processSourceSamples (const float* samples, int count);
    void acceptAnalysisSample (float sample);
    void analyseFrame();
    void acceptCandidate (float frequencyHz, float confidence);
    void acceptInvalidFrame();
    void publish (const TunerReading& next);
    void publishUndetected();

    juce::AbstractFifo fifo { fifoCapacity };
    std::array<float, fifoCapacity> fifoSamples {};
    std::array<float, workerBlockSize> workerSamples {};
    std::atomic<bool> enabled { true };
    std::atomic<bool> resetRequested { false };

    double sourceRate = 44100.0;
    double nextOutputSourcePosition = 0.0;
    std::uint64_t sourceSamplePosition = 0;
    bool hasPreviousFilteredSample = false;
    float previousFilteredSample = 0.0f;
    juce::IIRFilter highPass;
    juce::IIRFilter lowPassA;
    juce::IIRFilter lowPassB;

    std::array<float, frameSize> analysisRing {};
    std::array<float, frameSize> orderedFrame {};
    std::array<float, maximumLag + 1> difference {};
    std::array<float, maximumLag + 1> normalisedDifference {};
    int analysisWritePosition = 0;
    int analysisSamplesCollected = 0;
    int samplesSinceAnalysis = 0;

    int stableMidiNote = -1;
    int pendingMidiNote = -1;
    int pendingNoteFrames = 0;
    int invalidFrames = 0;
    std::array<float, 3> recentCents {};
    int recentCentsCount = 0;
    int recentCentsPosition = 0;
    float lastConfidence = 0.0f;

    mutable juce::CriticalSection readingLock;
    TunerReading reading;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TunerDetector)
};

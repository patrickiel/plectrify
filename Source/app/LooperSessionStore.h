#pragma once

#include <JuceHeader.h>

#include <functional>
#include <memory>

/**
    Background save/load of looper sessions as stereo 32-bit float WAVs in one
    directory (looper-sessions/ under the app-data dir). Float WAV round-trips
    the loop buffer exactly — a post-chain loop can legitimately exceed 0 dBFS,
    which integer PCM would clip.

    Threading: saveAsync/loadAsync are message-thread calls; the file work runs
    on a single pool thread (jobs execute in submission order) and onDone is
    marshalled back to the message thread. The store only guarantees the
    callback's thread — callers guard their own lifetime inside it (e.g. a
    Component::SafePointer). The destructor blocks until in-flight jobs finish,
    so a job never outlives the store.
*/
class LooperSessionStore
{
public:
    struct SaveResult
    {
        bool ok = false;
        juce::String fileName;        // name only, inside the sessions dir
        double durationSeconds = 0.0;
        double sampleRate = 0.0;
        juce::int64 timestampMs = 0;  // epoch ms at the moment of the save
    };

    struct LoadResult
    {
        bool ok = false;
        juce::AudioBuffer<float> buffer;  // stereo, allocated to maxSamples when ok
        int lengthSamples = 0;
    };

    explicit LooperSessionStore (juce::File sessionsDirectory)
        : directory (std::move (sessionsDirectory)) {}

    ~LooperSessionStore() { pool.removeAllJobs (true, 5000); }

    /** Writes `lengthSamples` of `audio` as session-YYYYMMDD-HHMMSS.wav
        (collision-suffixed) via a temp file + rename. */
    void saveAsync (juce::AudioBuffer<float>&& audio, int lengthSamples, double sampleRate,
                    std::function<void (SaveResult)> onDone);

    /** Reads a session WAV (the caller has already sandbox-resolved `file`),
        resampling to targetSampleRate when the rates differ, into a buffer
        allocated at the full maxSamples size — the shape
        LooperProcessor::stageLoadedLoop requires. */
    void loadAsync (juce::File file, double targetSampleRate, int maxSamples,
                    std::function<void (LoadResult)> onDone);

private:
    static SaveResult writeWav (const juce::File& directory, const juce::AudioBuffer<float>& audio,
                                int lengthSamples, double sampleRate, juce::Time timestamp);
    static LoadResult readWav (const juce::File& file, double targetSampleRate, int maxSamples);

    juce::File directory;
    juce::ThreadPool pool { 1 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LooperSessionStore)
};

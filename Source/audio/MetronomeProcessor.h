#pragma once

#include <JuceHeader.h>

#include "PassthroughProcessor.h"

#include <atomic>
#include <cstdint>

/**
    Fixed metronome node: passes the signal through untouched and adds a
    synthesized click on top. A practice click, not a transport — it owns no
    song position, drives nothing else in the rig, and the looper is
    deliberately not synced to it.

    Each beat of the bar carries its own level (off / soft / normal / accent;
    the UI exposes all but soft, which survives for stored patterns),
    so the whole bar is a pattern rather than a single "accent beat 1" flag:
    3+3+2 over 8 beats is just a pattern, and muting beats is how you practise
    against an implied pulse. Between beats an optional subdivision fires a
    quieter, higher click.

    Beats and subdivisions run off one counter at the subdivision rate, so
    they cannot drift apart: tick n is a beat when n % subdivision == 0. A
    live BPM or subdivision change recomputes the tick length but leaves the
    countdown alone, so the click never doubles or skips at the change.

    Threading: the message thread only ever calls the setters, postCommand()
    and getStatus() — every cross-thread field is a single atomic, including
    the beat pattern, which is packed two bits per beat into one 64-bit word
    so re-tapping a pad can never expose a half-updated bar to the audio
    thread. The tick counter, both click voices and their envelopes are
    audio-thread-only. processBlock never allocates, locks or blocks; there
    are no buffers to size, so prepareToPlay only computes constants.

    Latency: the node sits at the end of the chain, so the click is not
    delayed by plugin latency while the monitored guitar is — the click leads
    the player by the chain's latency. Inherent to a post-chain click;
    compensating would need a delay line on the dry path.
*/
class MetronomeProcessor final : public PassthroughProcessor
{
public:
    enum class Command { none = 0, sync };
    enum class BeatLevel { off = 0, soft, normal, accent };

    struct Status
    {
        bool running = false;
        int beat = 0;          // 0-based, the beat currently sounding
        float beatPhase = 0.0f; // 0..1 through that beat
    };

    MetronomeProcessor() : PassthroughProcessor ("Metronome") {}

    // --- ranges (mirrored in ui/src/features/metronome/) --------------------
    static constexpr float minBpm = 40.0f;
    static constexpr float maxBpm = 240.0f;
    static constexpr float defaultBpm = 120.0f;
    static constexpr int maxBeatsPerBar = 12;
    static constexpr int defaultBeatsPerBar = 4;
    static constexpr int maxSubdivision = 4;
    static constexpr float minLevelDb = -40.0f;
    static constexpr float maxLevelDb = 0.0f;
    static constexpr float defaultLevelDb = -12.0f;

    /** Two bits per beat, beat n at bits 2n..2n+1 — the whole bar in one
        lock-free word. */
    static constexpr BeatLevel levelAt (std::uint64_t pattern, int beat) noexcept
    {
        return (BeatLevel) ((pattern >> (2 * beat)) & 0x3ull);
    }

    static constexpr std::uint64_t packLevel (std::uint64_t pattern, int beat, BeatLevel level) noexcept
    {
        const auto shift = 2 * beat;
        return (pattern & ~(0x3ull << shift)) | ((std::uint64_t) level << shift);
    }

    /** Accent on one, everything else normal, for every beat the bar could
        grow to — so widening the bar never reveals silent beats. */
    static constexpr std::uint64_t defaultPattern() noexcept
    {
        std::uint64_t pattern = 0;
        for (int beat = 0; beat < maxBeatsPerBar; ++beat)
            pattern = packLevel (pattern, beat, beat == 0 ? BeatLevel::accent : BeatLevel::normal);
        return pattern;
    }

    // --- message thread -----------------------------------------------------

    /** Latched into one atomic slot and applied at the start of the next
        block; foot presses never arrive faster than a block, so last-wins is
        safe. */
    void postCommand (Command command) noexcept
    {
        pendingCommand.store ((int) command, std::memory_order_release);
    }

    void setEnabled (bool on) noexcept { enabled.store (on, std::memory_order_relaxed); }
    bool isEnabled() const noexcept { return enabled.load (std::memory_order_relaxed); }

    /** True while the click is audible. The auto-standby detector must not
        park a rig that is still clicking under a silent guitar — the node
        lives outside the slot list, so nothing else would ever suspend it. */
    bool isRunning() const noexcept { return isEnabled(); }

    void setBpm (float value) noexcept
    {
        bpm.store (juce::jlimit (minBpm, maxBpm, value), std::memory_order_relaxed);
    }
    float getBpm() const noexcept { return bpm.load (std::memory_order_relaxed); }

    void setBeatsPerBar (int value) noexcept
    {
        beatsPerBar.store (juce::jlimit (1, maxBeatsPerBar, value), std::memory_order_relaxed);
    }
    int getBeatsPerBar() const noexcept { return beatsPerBar.load (std::memory_order_relaxed); }

    /** 1 = beats only; n = n-1 quieter clicks between each pair of beats. */
    void setSubdivision (int value) noexcept
    {
        subdivision.store (juce::jlimit (1, maxSubdivision, value), std::memory_order_relaxed);
    }
    int getSubdivision() const noexcept { return subdivision.load (std::memory_order_relaxed); }

    void setBeatPattern (std::uint64_t pattern) noexcept
    {
        beatPattern.store (pattern, std::memory_order_relaxed);
    }
    std::uint64_t getBeatPattern() const noexcept { return beatPattern.load (std::memory_order_relaxed); }

    void setLevelDb (float db) noexcept
    {
        const float clamped = juce::jlimit (minLevelDb, maxLevelDb, db);
        levelDb.store (clamped, std::memory_order_relaxed);
        levelGain.store (juce::Decibels::decibelsToGain (clamped), std::memory_order_relaxed);
    }
    float getLevelDb() const noexcept { return levelDb.load (std::memory_order_relaxed); }

    Status getStatus() const noexcept
    {
        return { publishedRunning.load (std::memory_order_relaxed),
                 publishedBeat.load (std::memory_order_relaxed),
                 publishedBeatPhase.load (std::memory_order_relaxed) };
    }

    void prepareToPlay (double rate, int blockSize) override;
    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override;

private:
    /** One enveloped sine burst. Two of these exist because a beat click can
        still be ringing when the next subdivision fires: at 240 BPM divided by
        4 a tick lands every ~62 ms, and the 35 ms click leaves no margin for
        sharing one voice across a live tempo change. */
    struct ClickVoice
    {
        void start (double frequency, float voiceGain, int lengthSamples, double rate) noexcept
        {
            phase = 0.0;
            increment = juce::MathConstants<double>::twoPi * frequency / rate;
            length = juce::jmax (1, lengthSamples);
            remaining = length;
            gain = voiceGain;
        }

        void reset() noexcept { remaining = 0; }

        float next() noexcept
        {
            if (remaining <= 0)
                return 0.0f;

            // Linear decay to exactly zero at the end of the burst, so the
            // voice stops dead rather than leaving a denormal tail running.
            const float envelope = (float) remaining / (float) length;
            const auto sample = (float) std::sin (phase) * envelope * gain;
            phase += increment;
            --remaining;
            return sample;
        }

        double phase = 0.0, increment = 0.0;
        int length = 1, remaining = 0;
        float gain = 0.0f;
    };

    void resetBar() noexcept;
    void fireTick (int tick, int division, std::uint64_t pattern) noexcept;

    static constexpr double clickSeconds = 0.035;
    static constexpr double accentHz = 1760.0;
    static constexpr double beatHz = 880.0;
    static constexpr double subdivisionHz = 1320.0;
    // Accent peaks at 1.0 so the level control alone sets the ceiling — at
    // maxLevelDb the loudest click is exactly full scale, never over.
    static constexpr float accentGain = 1.0f;
    static constexpr float normalGain = 0.7f;
    static constexpr float softGain = 0.35f;
    static constexpr float subdivisionGain = 0.28f;

    // --- cross-thread (single atomics each way) -----------------------------
    std::atomic<int> pendingCommand { 0 };
    std::atomic<bool> enabled { false };
    std::atomic<float> bpm { defaultBpm };
    std::atomic<int> beatsPerBar { defaultBeatsPerBar };
    std::atomic<int> subdivision { 1 };
    std::atomic<std::uint64_t> beatPattern { defaultPattern() };
    std::atomic<float> levelDb { defaultLevelDb };
    std::atomic<float> levelGain { 0.25118864f };  // 10^(-12/20), kept in step by setLevelDb
    std::atomic<bool> publishedRunning { false };
    std::atomic<int> publishedBeat { 0 };
    std::atomic<float> publishedBeatPhase { 0.0f };

    // --- audio-thread-only --------------------------------------------------
    double sampleRate = 0.0;
    int clickSamples = 0;
    double samplesPerTick = 0.0;
    double samplesToNextTick = 0.0;
    int tickIndex = 0;    // the tick about to fire
    int currentTick = 0;  // the tick sounding now
    bool wasEnabled = false;
    ClickVoice beatVoice, subVoice;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MetronomeProcessor)
};

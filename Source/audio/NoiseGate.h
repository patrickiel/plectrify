#pragma once

#include <JuceHeader.h>

#include <atomic>
#include <cmath>

/**
    The built-in noise gate: a downward expander that sits on the guitar input,
    right after the input gain and the IN meter, before the first module.

    It is a gate in the sense a pedalboard means it — first in the chain, on
    the clean signal, where the gap between a played note and the pickup's hum
    is widest and the decision is easiest — rather than an attempt to clean
    up a high-gain amp's output after the fact, where the amp's compression
    has pulled the two together. Whatever the amp sim then amplifies is a
    signal the gate has already quietened, which is also why it can be gentle.

    **Detector.** A peak follower with instant attack and a 20 ms decay on the
    guitar channel: the two channels are identical here (the router has just
    fanned the one jack onto both), so one envelope serves both. Peak rather
    than RMS because the IN meter beside the threshold control is a peak
    meter, and a threshold has to be set against the number the user can see.

    **Decision.** Opens the instant the envelope reaches the threshold; closes
    only once it has sat `hysteresisDb` below it for the whole hold time. The
    hysteresis is what stops a note decaying through the threshold from
    chattering the gate open and shut on every ripple, and the hold is what
    keeps a palm-muted chug from being cut between hits.

    **Gain.** Open is unity. Closed depends on the *shape*: soft and firm are
    expander slopes — the gain falls 2 or 4 dB for every dB the envelope sits
    below the close threshold, so a dying note is eased out at a multiple of
    its own decay rather than cut; hard is the classic gate, straight to the
    floor. The floor is the *range*: how far down closed goes, which is also
    how far the gain has to climb back on the way open, and the biggest
    single factor in whether that opening is heard as a click. Gain moves at
    the attack rate on the way up and the release rate on the way down, both
    as constant dB per second over the range, which is how every hardware
    gate's times are specified. Switching the gate off has its own ramp back
    to unity (`switchMs`), whatever the attack says — the player pressed a
    button, not a string; switching it on over silence closes at the release
    rate, like any other close.

    Threading: setters and getters are atomics for the message thread;
    prepare() and process() belong to the audio thread. getReductionDb() is
    the one readout, published once per block for the status bar.
*/
class NoiseGate
{
public:
    NoiseGate() = default;

    /** How the gain behaves below the close threshold. The page mirrors these
        as 'soft' | 'firm' | 'hard' (see noiseGate.ts); the integer values are
        what cross the bridge and sit in audio_settings.xml. */
    enum class Shape : int
    {
        soft = 0,   ///< 2 dB down per dB below the close threshold
        firm = 1,   ///< 4 dB per dB
        hard = 2    ///< straight to the range floor
    };

    // The player's controls, with the ranges the page offers. Threshold, hold,
    // release and shape decide *when*; attack and range decide *how abruptly*.
    static constexpr float defaultThresholdDb = -50.0f;
    static constexpr float minThresholdDb = -80.0f;
    static constexpr float maxThresholdDb = -10.0f;
    static constexpr float defaultHoldMs = 50.0f;
    static constexpr float minHoldMs = 0.0f;
    static constexpr float maxHoldMs = 500.0f;
    static constexpr float defaultReleaseMs = 250.0f;
    static constexpr float minReleaseMs = 10.0f;
    static constexpr float maxReleaseMs = 2000.0f;
    // 2 ms is just slow enough that opening from a deep floor is not a click,
    // and fast enough that a pick attack keeps its edge; 0.1 is the hardware
    // "fast" setting, 50 a swell.
    static constexpr float defaultAttackMs = 2.0f;
    static constexpr float minAttackMs = 0.1f;
    static constexpr float maxAttackMs = 50.0f;
    // 50 dB under a -50 dB threshold leaves hum at -100 dBFS at worst, which
    // is gone, while the gain has 20 dB less to climb than at the maximum;
    // 10 dB is a gentle duck, 70 is silence and the most the maths allows
    // before the linear gain denormalises.
    static constexpr float defaultRangeDb = 50.0f;
    static constexpr float minRangeDb = 10.0f;
    static constexpr float maxRangeDb = 70.0f;
    static constexpr Shape defaultShape = Shape::firm;

    // Fixed by design: tunings of the detector, not musical choices.
    //
    // The close threshold sits this far under the open threshold.
    static constexpr float hysteresisDb = 6.0f;
    // Detector decay. 20 ms ripples under 3 dB over a low E's half cycle —
    // inside the hysteresis, so a sustained note cannot chatter the gate — and
    // lets a stopped string fall the 36 dB from a -20 dBFS note to the close
    // threshold in some 80 ms, which is what the player feels as the gate's
    // reaction time before the hold even starts.
    static constexpr float detectorDecayMs = 20.0f;
    // The ramp for the on/off switch itself, over the full maximum range.
    static constexpr float switchMs = 30.0f;

    static constexpr float slopeFor (Shape shape) noexcept
    {
        return shape == Shape::soft ? 2.0f : shape == Shape::firm ? 4.0f : 0.0f;
    }

    void setEnabled (bool shouldGate) noexcept     { enabled.store (shouldGate); }
    bool isEnabled() const noexcept                 { return enabled.load(); }
    void setThresholdDb (float db) noexcept
    {
        thresholdDb.store (juce::jlimit (minThresholdDb, maxThresholdDb, db));
    }
    float getThresholdDb() const noexcept           { return thresholdDb.load(); }
    void setHoldMs (float ms) noexcept              { holdMs.store (juce::jlimit (minHoldMs, maxHoldMs, ms)); }
    float getHoldMs() const noexcept                { return holdMs.load(); }
    void setReleaseMs (float ms) noexcept
    {
        releaseMs.store (juce::jlimit (minReleaseMs, maxReleaseMs, ms));
    }
    float getReleaseMs() const noexcept             { return releaseMs.load(); }
    void setAttackMs (float ms) noexcept            { attackMs.store (juce::jlimit (minAttackMs, maxAttackMs, ms)); }
    float getAttackMs() const noexcept              { return attackMs.load(); }
    void setRangeDb (float db) noexcept             { rangeDb.store (juce::jlimit (minRangeDb, maxRangeDb, db)); }
    float getRangeDb() const noexcept               { return rangeDb.load(); }
    void setShape (Shape newShape) noexcept         { shape.store ((int) newShape); }
    /** Clamped: an out-of-range integer from a document reads as the default. */
    void setShape (int value) noexcept
    {
        shape.store (value >= 0 && value <= (int) Shape::hard ? value : (int) defaultShape);
    }
    Shape getShape() const noexcept                 { return (Shape) shape.load(); }

    /** The attenuation in force at the end of the last block, in dB (0 when
        open or disabled, negative while closing or closed). Message thread. */
    float getReductionDb() const noexcept           { return reductionDb.load(); }
    /** The decision, as distinct from the gain: false from the first block the
        gate has decided to close, while the release is still ramping the gain
        down — which is what a lamp should show. True whenever the gate is off.
        Message thread. */
    bool isOpen() const noexcept                    { return openState.load(); }

    /** Audio thread, before the first block and on every device change. */
    void prepare (double rate) noexcept
    {
        sampleRate = juce::jmax (1.0, rate);
        detectorCoefficient = (float) std::exp (-1.0 / (sampleRate * detectorDecayMs * 0.001));
        switchStepDb = maxRangeDb / (float) (sampleRate * switchMs * 0.001);
        reset();
    }

    void reset() noexcept
    {
        envelope = 0.0f;
        gainDb = 0.0f;
        lastGainDb = 0.0f;
        lastGain = 1.0f;
        open = false;
        holdRemaining = 0;
        reductionDb.store (0.0f);
        openState.store (true);
    }

    /** Audio thread. Detects on channel 0 and applies the one gain to every
        channel. A disabled gate still runs while its gain is below unity,
        ramping back up at the switch rate — so switching it off mid-note is a
        fade-in rather than a step — and keeps its detector warm while idle,
        so switching it on finds a decision already made. */
    void process (juce::AudioBuffer<float>& buffer) noexcept
    {
        const int numSamples = buffer.getNumSamples();
        const int numChannels = buffer.getNumChannels();
        if (numSamples <= 0 || numChannels <= 0)
            return;

        // One read per block, so a control dragged mid-block cannot tear.
        const bool gating = enabled.load();
        const float openThresholdDb = thresholdDb.load();
        const float closeThresholdDb = openThresholdDb - hysteresisDb;
        const float openLinear = juce::Decibels::decibelsToGain (openThresholdDb);
        const float closeLinear = juce::Decibels::decibelsToGain (closeThresholdDb);
        const int holdSamples = (int) (sampleRate * holdMs.load() * 0.001);
        const float range = rangeDb.load();
        const float slope = slopeFor (getShape());
        const float attackStepDb = range / (float) (sampleRate * attackMs.load() * 0.001);
        const float releaseStepDb = range / (float) (sampleRate * releaseMs.load() * 0.001);

        // Nothing to do, and the common case for a gate left off: skip the
        // whole pass rather than multiplying every sample by one.
        if (! gating && gainDb >= 0.0f)
        {
            // Keep the detector warm so enabling it mid-note is decided on the
            // note, not on an empty envelope.
            const float* in = buffer.getReadPointer (0);
            for (int i = 0; i < numSamples; ++i)
                envelope = juce::jmax (std::abs (in[i]), envelope * detectorCoefficient);
            if (envelope < denormalFloor) envelope = 0.0f;
            // And keep the decision that envelope implies: a note sustaining
            // inside the hysteresis band when the gate is switched on is still
            // open, not one the gate has already closed over.
            open = envelope >= closeLinear;
            holdRemaining = open ? holdSamples : 0;
            reductionDb.store (0.0f);
            openState.store (true);
            return;
        }

        juce::ScopedNoDenormals noDenormals;
        const float* in = buffer.getReadPointer (0);

        for (int i = 0; i < numSamples; ++i)
        {
            const float magnitude = std::abs (in[i]);
            envelope = magnitude > envelope ? magnitude : envelope * detectorCoefficient;

            float targetDb = 0.0f;
            float upStepDb = switchStepDb;
            float downStepDb = switchStepDb;
            if (gating)
            {
                upStepDb = attackStepDb;
                downStepDb = releaseStepDb;

                if (envelope >= openLinear)
                {
                    open = true;
                    holdRemaining = holdSamples;
                }
                else if (open)
                {
                    // Inside the hysteresis band the gate stays open and the
                    // hold is not spent; only time spent under the close
                    // threshold counts against it.
                    if (envelope >= closeLinear)
                        holdRemaining = holdSamples;
                    else if (holdRemaining > 0)
                        --holdRemaining;
                    else
                        open = false;
                }

                if (! open)
                {
                    if (slope <= 0.0f)
                    {
                        targetDb = -range;
                    }
                    else
                    {
                        const float levelDb = juce::Decibels::gainToDecibels (envelope, -120.0f);
                        targetDb = juce::jlimit (-range, 0.0f, slope * (levelDb - closeThresholdDb));
                    }
                }
            }

            if (targetDb > gainDb)
                gainDb = juce::jmin (targetDb, gainDb + upStepDb);
            else if (targetDb < gainDb)
                gainDb = juce::jmax (targetDb, gainDb - downStepDb);

            if (! juce::exactlyEqual (gainDb, lastGainDb))
            {
                lastGainDb = gainDb;
                lastGain = gainDb >= 0.0f ? 1.0f : juce::Decibels::decibelsToGain (gainDb);
            }

            if (lastGain < 1.0f)
                for (int ch = 0; ch < numChannels; ++ch)
                    buffer.getWritePointer (ch)[i] *= lastGain;
        }

        if (envelope < denormalFloor) envelope = 0.0f;
        reductionDb.store (gainDb);
        openState.store (! gating || open);
    }

private:
    static constexpr float denormalFloor = 1.0e-9f;

    std::atomic<bool> enabled { false };
    std::atomic<float> thresholdDb { defaultThresholdDb };
    std::atomic<float> holdMs { defaultHoldMs };
    std::atomic<float> releaseMs { defaultReleaseMs };
    std::atomic<float> attackMs { defaultAttackMs };
    std::atomic<float> rangeDb { defaultRangeDb };
    std::atomic<int> shape { (int) defaultShape };
    std::atomic<float> reductionDb { 0.0f };
    std::atomic<bool> openState { true };

    // Audio-thread-only state; sized on prepare.
    double sampleRate = 44100.0;
    float detectorCoefficient = 0.0f;
    float switchStepDb = 1.0f;
    float envelope = 0.0f;
    float gainDb = 0.0f;
    float lastGainDb = 0.0f;
    float lastGain = 1.0f;
    bool open = false;
    int holdRemaining = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NoiseGate)
};

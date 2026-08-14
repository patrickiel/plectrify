#pragma once

#include <JuceHeader.h>

#include "PassthroughProcessor.h"
#include "TunerDetector.h"

#include <atomic>

/**
    Fixed first node of the rack: presents the guitar as a mono signal on BOTH
    channels, so the rest of the chain (amp sims are usually mono) and the
    speakers all get the guitar.

    The guitar arrives on the graph's first input channel — the device
    selector decides which hardware channel that is (enable only the jack the
    guitar is plugged into). Channel 0 is copied onto channel 1, input gain is
    applied, and the tuner taps the pre-gain signal.
*/
class InputRouterProcessor final : public PassthroughProcessor
{
public:
    InputRouterProcessor() : PassthroughProcessor ("Guitar Input Router") {}

    void setGainDb (float db) noexcept            { gainDb.store (juce::jlimit (-24.0f, 24.0f, db)); }
    float getGainDb() const noexcept               { return gainDb.load(); }
    void setTunerEnabled (bool enabled) noexcept   { tunerDetector.setEnabled (enabled); }
    bool isTunerEnabled() const noexcept           { return tunerDetector.isEnabled(); }
    float consumePeak() noexcept                    { return peak.consume(); }
    TunerReading getTunerReading() const            { return tunerDetector.getReading(); }

    /** Message thread. A second, independent tap of the same level for the
        auto-standby idle detector. consumePeak() is destructive and the status
        meter owns it, so the two must not share one meter — a single consumer
        would starve the other of every block it read first. */
    float consumeStandbyPeak() noexcept             { return standbyPeak.consume(); }

    /** Message thread. While standby holds the rig idle the tuner's analysis
        thread would be the only DSP still running, so stop feeding it. Kept
        separate from setTunerEnabled(), which is the rack's effective manual-or-
        MIDI state and must survive a standby cycle untouched. */
    void setStandby (bool shouldStandby) noexcept   { standby.store (shouldStandby); }

    void prepareToPlay (double rate, int) override { tunerDetector.prepare (rate); }
    void releaseResources() override               { tunerDetector.release(); }

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        const int numSamples = buffer.getNumSamples();
        if (buffer.getNumChannels() < 2)
            return; // mono bus: nothing to fan out

        // The tuner observes the guitar channel before gain, keeping pitch
        // detection independent from the user's monitoring level.
        if (tunerDetector.isEnabled() && ! standby.load())
            tunerDetector.pushSamples (buffer.getReadPointer (0), numSamples);

        // Copy the guitar channel onto the other channel so both carry it.
        buffer.copyFrom (1, 0, buffer, 0, 0, numSamples);

        buffer.applyGain (juce::Decibels::decibelsToGain (gainDb.load()));

        // Both channels carry the same signal after the copy and a uniform
        // gain, so one magnitude pass feeds both taps. Post-gain, so the
        // standby threshold is expressed against the same number the status
        // bar's input meter shows the user.
        const float magnitude = buffer.getMagnitude (0, 0, numSamples);
        peak.update (magnitude);
        standbyPeak.update (magnitude);
    }

private:
    std::atomic<float> gainDb { 0.0f };
    PeakMeter peak;
    PeakMeter standbyPeak;
    std::atomic<bool> standby { false };
    TunerDetector tunerDetector;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (InputRouterProcessor)
};

/** Fixed final stage: applies master output gain, exposes a peak meter, and
    mutes only the device-bound signal. Its controls are atomics so UI changes
    never touch the audio thread's graph topology.

    Five independent reasons can silence the output — the MIDI live tuner, a
    rig load, auto-standby, the feedback guard and the user's own mute button —
    and none may clear another's, so each owns its own flag. The mute is a ramp
    target rather than a switch: a hard clear pops, and every reason engages
    while the amp is still ringing.

    Standby deliberately does not reuse the load mute: a rig load releases its
    mute on a 120 s watchdog, which would fire partway through a park that is
    meant to last hours.

    The feedback guard is unlike the other three in one way that matters: it
    **latches**. A guitar rig is an acoustic loop, and once it runs away the
    only thing that ended it was a hand on a fader. Releasing the mute on our
    own would just re-enter the loop, so the flag stays set until the user
    clears it — by which time they have turned something down. */
class OutputLevelProcessor final : public PassthroughProcessor
{
public:
    OutputLevelProcessor() : PassthroughProcessor ("Master Output") {}

    void setGainDb (float db) noexcept { gainDb.store (juce::jlimit (-24.0f, 24.0f, db)); }
    float getGainDb() const noexcept { return gainDb.load(); }
    void setTunerMute (bool shouldMute) noexcept { tunerMute.store (shouldMute); }
    void setLoadMute (bool shouldMute) noexcept { loadMute.store (shouldMute); }
    void setStandbyMute (bool shouldMute) noexcept { standbyMute.store (shouldMute); }
    /** The user's own mute button in the status bar. Its own flag rather than a
        second writer of the feedback latch: disarming the guard drops that
        latch, and a hand-muted rig must not come back up because of it. */
    void setUserMute (bool shouldMute) noexcept { userMute.store (shouldMute); }
    bool isUserMuted() const noexcept { return userMute.load(); }
    bool isMuted() const noexcept
    {
        return tunerMute.load() || loadMute.load() || standbyMute.load()
               || feedbackTripped.load() || userMute.load();
    }
    float consumePeak() noexcept { return peak.consume(); }

    /** Message thread. Turning the guard off also drops any latch it is
        holding, in that order, so no block can see "disabled but still muted". */
    void setFeedbackGuardEnabled (bool shouldGuard) noexcept
    {
        if (! shouldGuard)
            feedbackTripped.store (false);
        feedbackGuardEnabled.store (shouldGuard);
    }
    bool isFeedbackGuardEnabled() const noexcept { return feedbackGuardEnabled.load(); }

    /** Message thread. The engine sets this; the user clears it. */
    void setFeedbackTripped (bool tripped) noexcept { feedbackTripped.store (tripped); }
    bool isFeedbackTripped() const noexcept { return feedbackTripped.load(); }

    void prepareToPlay (double rate, int) override
    {
        rampStep = (float) (1.0 / juce::jmax (1.0, rate * fadeSeconds));
        const auto safeRate = juce::jmax (1.0, rate);
        feedbackSaturatedDwellSamples = (int) (safeRate * feedbackSaturatedDwellSeconds);
        feedbackSteadyDwellSamples = (int) (safeRate * feedbackSteadyDwellSeconds);
        feedbackHotSamples = 0;
        feedbackSteadySamples = 0;
        snap = true;
    }

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        const int numSamples = buffer.getNumSamples();
        const float gain = juce::Decibels::decibelsToGain (gainDb.load());

        detectFeedback (buffer, numSamples);

        const float target = isMuted() ? 0.0f : 1.0f;
        if (snap) { current = target; snap = false; }
        const float next = target > current
                             ? juce::jmin (target, current + (float) numSamples * rampStep)
                             : juce::jmax (target, current - (float) numSamples * rampStep);

        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
            buffer.applyGainRamp (ch, 0, numSamples, gain * current, gain * next);
        current = next;

        // Meter what actually leaves: zero while muted, and no stale reading
        // left behind when the mute lifts.
        peak.update (buffer.getMagnitude (0, 0, numSamples));
        peak.update (buffer.getMagnitude (1, 0, numSamples));
    }

private:
    /** Audio thread. Watches what the chain hands us — before master gain and
        before the mute ramp — so the guard is independent of where the user has
        the fader and cannot be starved by its own mute.

        **Loudness is not the test.** Feedback does not have to be loud: a
        high-pitched squeal is close to a sine, and one sitting at -8 dBFS peak
        is only about -11 dBFS RMS — nowhere near saturation, and plenty painful.
        What separates it from playing is that it does not *move*. A plucked note
        decays, a chord changes, a player breathes; a feedback loop finds its
        level and holds it for as long as the guitar faces the speaker.

        So the slow path looks for a level that refuses to *fall*: audible, and
        never sagging more than 4 dB below its own running peak, for a second.
        Rising is free, which matters — a loop builds before it settles, and a
        rule that waited for a plateau would charge the room the build time on
        top of the dwell. The fast path is the separate case of a loop that has
        already driven the chain into saturation, where even a second is too long.

        Both are heuristics, and neither can be certain — which is why this is
        one click from off and one click from recovery rather than an algorithm
        that thinks it knows better than the player. */
    void detectFeedback (const juce::AudioBuffer<float>& buffer, int numSamples) noexcept
    {
        // Every reason to not be looking also restarts the dwell, rather than
        // leaving it parked where it stopped. A latch the user has just cleared,
        // a guard they have just re-armed and a rig that has just come back from
        // standby all owe the player a full dwell before they mute anything —
        // resuming a stale count would re-mute within a block or two of the
        // click that unmuted it.
        //
        // The other four mute reasons are in that list because a rig load, the
        // stage tuner or a standby wake hands this node a buffer that is not the
        // player's signal, and a false trip there would be the worst kind:
        // silence the user did not cause and cannot explain. A hand mute is
        // there for a plainer reason: nothing is reaching the speaker, so there
        // is no acoustic loop to catch, and a latch tripped behind a mute would
        // only be found as a rig that stays silent after unmuting.
        if (feedbackTripped.load() || ! feedbackGuardEnabled.load()
            || tunerMute.load() || loadMute.load() || standbyMute.load() || userMute.load())
        {
            feedbackHotSamples = 0;
            feedbackSteadySamples = 0;
            return;
        }

        float rms = 0.0f;
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
            rms = juce::jmax (rms, buffer.getRMSLevel (ch, 0, numSamples));

        // Fast path: already saturated.
        feedbackHotSamples = rms >= feedbackSaturatedRms ? feedbackHotSamples + numSamples : 0;

        // Slow path: audible, and not decaying. Rising is free — a loop builds
        // before it settles, and making it wait for a plateau would charge the
        // room the build time on top of the dwell. Only a real drop below the
        // run's own peak ends the run, and that is the half a guitar always
        // does: every note dies, this never does.
        if (rms < feedbackFloorRms)
        {
            feedbackSteadySamples = 0;
        }
        else if (feedbackSteadySamples <= 0
                 || rms < feedbackRunMaxRms * feedbackSagRatio)
        {
            feedbackRunMaxRms = rms;
            feedbackSteadySamples = numSamples;
        }
        else
        {
            feedbackRunMaxRms = juce::jmax (feedbackRunMaxRms, rms);
            feedbackSteadySamples += numSamples;
        }

        if ((feedbackSaturatedDwellSamples > 0 && feedbackHotSamples >= feedbackSaturatedDwellSamples)
            || (feedbackSteadyDwellSamples > 0 && feedbackSteadySamples >= feedbackSteadyDwellSamples))
            feedbackTripped.store (true);
    }

    // Long enough to be inaudible at any block size, far shorter than the 50ms
    // MainComponent waits before tearing the chain down.
    static constexpr double fadeSeconds = 0.015;
    // Fast path. -3 dBFS RMS is a waveform squared off against the ceiling,
    // which no guitar signal sustains; 0.3 s is longer than a strum's saturated
    // attack and short enough to save the room's ears.
    static constexpr float feedbackSaturatedRms = 0.71f;
    static constexpr double feedbackSaturatedDwellSeconds = 0.3;
    // Slow path. -20 dBFS RMS is the floor of "loud enough to be a problem" and
    // sits above a high-gain amp sim's idle hiss, which is itself perfectly
    // steady and must never trip this. -4 dB is the sag a run tolerates before
    // it counts as decay: loose enough for a squeal that wavers or beats against
    // a second one, far tighter than the envelope of any note. 1 s of that is
    // the whole budget — long enough that a note has visibly died inside it,
    // short enough to be bearable with a squeal in the room. These two are the
    // dials: raise the sag or the dwell if playing ever trips it, lower the
    // dwell if it feels slow.
    static constexpr float feedbackFloorRms = 0.1f;
    static constexpr float feedbackSagRatio = 0.63f;
    static constexpr double feedbackSteadyDwellSeconds = 1.0;

    std::atomic<float> gainDb { 0.0f };
    std::atomic<bool> tunerMute { false };
    std::atomic<bool> loadMute { false };
    std::atomic<bool> standbyMute { false };
    std::atomic<bool> feedbackGuardEnabled { true };
    std::atomic<bool> feedbackTripped { false };
    std::atomic<bool> userMute { false };
    PeakMeter peak;
    // Audio-thread-only ramp state; snapped to the target on prepare.
    float rampStep = 1.0f;
    float current = 1.0f;
    bool snap = true;
    // Audio-thread-only guard state; sized and zeroed on prepare.
    int feedbackSaturatedDwellSamples = 0;
    int feedbackSteadyDwellSamples = 0;
    int feedbackHotSamples = 0;
    int feedbackSteadySamples = 0;
    float feedbackRunMaxRms = 0.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (OutputLevelProcessor)
};

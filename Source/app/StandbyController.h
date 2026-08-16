#pragma once

#include <JuceHeader.h>

#include <functional>

/**
    Two-stage idle shutdown for the rig ("Auto Standby").

    A big rig costs real CPU and RAM continuously, even with nobody playing.
    Stage 1 (light) suspends every plugin's DSP: CPU falls to ~0, RAM is
    untouched, and waking is a single flag flip. Stage 2 (deep) additionally
    parks each plugin's state and destroys the instances, freeing their RAM at
    the cost of a rebuild on wake.

    Message thread only. This class holds nothing and does nothing itself: the
    caller samples the world into a Tick once per timer callback, and every
    effect leaves through Callbacks. That keeps the whole policy — timeouts,
    thresholds, transition order — testable without a message loop, an audio
    device or a real plugin, and keeps the knowledge of *what* suspension and
    parking mean in MainComponent.

    Timeouts integrate real elapsed milliseconds, never tick counts: at 15 Hz a
    plugin's prepareToPlay or a native modal can swallow whole seconds of timer
    callbacks, and a tick-counting timeout would silently stretch.
*/
class StandbyController
{
public:
    StandbyController() = default;

    enum class Stage
    {
        active,  ///< Playing, or counting down towards standby.
        light,   ///< Every plugin suspended; output muted. Wake is instant.
        deep,    ///< Plugins captured and destroyed. Wake is an async rebuild.
        waking   ///< Rebuilding from deep; ends at deepWakeFinished().
    };

    /** User preference, owned by the TypeScript AppSettings and pushed in over
        the bridge. Zero minutes disables that stage. Defaults are "off", so a
        settings.json that fails to load leaves standby disabled rather than
        silencing someone's rig. */
    struct Config
    {
        bool   enabled           = false;
        double lightAfterMinutes = 10.0;
        double deepAfterMinutes  = 0.0;    // 0 = never go deep (separately opt-in)
        float  wakeThresholdDb   = -50.0f;
    };

    /** Everything the policy needs, sampled once per tick by the caller. */
    struct Tick
    {
        juce::uint32 nowMs      = 0;      // juce::Time::getMillisecondCounter()
        float        inputPeak  = 0.0f;   // linear, from consumeStandbyInputPeak()
        bool         blocked    = false;  // a guard forbids standby right now
        bool         hasPlugins = false;  // an empty rack has nothing to reclaim
    };

    /** All invoked on the message thread, from inside tick()/noteActivity(). */
    struct Callbacks
    {
        std::function<void()> enterLight;        // mute, then suspend every plugin
        std::function<void()> exitLight;         // resume every plugin, then un-mute
        std::function<void()> enterDeep;         // capture + tear the rack down
        std::function<void()> beginWakeFromDeep; // rebuild; ends in deepWakeFinished()
        std::function<void()> stageChanged;      // push a status echo immediately
    };

    void setCallbacks (Callbacks newCallbacks) { callbacks = std::move (newCallbacks); }

    Config getConfig() const noexcept { return config; }

    /** Clamps the incoming preference and wakes immediately if standby was
        switched off, so disabling the feature can never leave a rig silent. */
    void setConfig (const Config& newConfig, juce::uint32 nowMs)
    {
        config = newConfig;
        config.lightAfterMinutes = juce::jlimit (0.0, 24.0 * 60.0, config.lightAfterMinutes);
        config.deepAfterMinutes  = juce::jlimit (0.0, 24.0 * 60.0, config.deepAfterMinutes);
        config.wakeThresholdDb   = juce::jlimit (-100.0f, 0.0f, config.wakeThresholdDb);

        // Deep can never precede light: the stages are sequential, and a deep
        // timeout below the light one would otherwise skip stage 1 entirely.
        if (config.deepAfterMinutes > 0.0)
            config.deepAfterMinutes = juce::jmax (config.deepAfterMinutes, config.lightAfterMinutes);

        if (! config.enabled)
            noteActivity (nowMs);
    }

    Stage getStage() const noexcept { return stage; }

    static const char* stageName (Stage s) noexcept
    {
        switch (s)
        {
            case Stage::light:  return "light";
            case Stage::deep:   return "deep";
            case Stage::waking: return "waking";
            case Stage::active: break;
        }
        return "active";
    }

    /** Seconds of continuous input silence — drives the UI's countdown. */
    double getIdleSeconds (juce::uint32 nowMs) const noexcept
    {
        if (! started)
            return 0.0;

        return static_cast<double> (elapsedMs (nowMs)) / 1000.0;
    }

    /** 15 Hz, from MainComponent::timerCallback(). */
    void tick (const Tick& input)
    {
        if (! started)
        {
            started = true;
            lastActivityMs = input.nowMs;
        }

        // A wake from deep owns us until it reports back: its rebuild takes
        // seconds and runs through the message loop, so ticks arrive while it
        // is still in flight.
        if (stage == Stage::waking)
            return;

        if (! config.enabled)
        {
            if (stage != Stage::active)
                noteActivity (input.nowMs);
            return;
        }

        if (input.inputPeak > juce::Decibels::decibelsToGain (config.wakeThresholdDb))
        {
            noteActivity (input.nowMs);
            return;
        }

        // Every blocker — an open editor, a running scan, a rig load, a modal —
        // is the user doing something, so it counts as activity rather than
        // merely freezing the countdown. That leaves one predicate instead of
        // two that have to interact correctly.
        if (input.blocked || ! input.hasPlugins)
        {
            noteActivity (input.nowMs);
            return;
        }

        const auto idleMs = elapsedMs (input.nowMs);

        if (stage == Stage::active && config.lightAfterMinutes > 0.0
            && idleMs >= toMs (config.lightAfterMinutes))
        {
            stage = Stage::light;
            invoke (callbacks.enterLight);
            invoke (callbacks.stageChanged);
            return;
        }

        if (stage == Stage::light && config.deepAfterMinutes > 0.0
            && idleMs >= toMs (config.deepAfterMinutes))
        {
            stage = Stage::deep;
            invoke (callbacks.enterDeep);
            invoke (callbacks.stageChanged);
        }
    }

    /** Any explicit user action: an allowlisted bridge event, the UI's throttled
        activity ping, or the manual wake button. Restarts the clock and wakes. */
    void noteActivity (juce::uint32 nowMs)
    {
        started = true;
        lastActivityMs = nowMs;

        switch (stage)
        {
            case Stage::light:
                stage = Stage::active;
                invoke (callbacks.exitLight);
                invoke (callbacks.stageChanged);
                break;

            case Stage::deep:
                // The rebuild is async; stay in `waking` until it reports back
                // so repeated activity can't start a second one.
                stage = Stage::waking;
                invoke (callbacks.beginWakeFromDeep);
                invoke (callbacks.stageChanged);
                break;

            case Stage::active:
            case Stage::waking:
                break;
        }
    }

    /** Drop into light standby immediately, ignoring the idle timeout. Backs the
        UI's "sleep now" command — without it the feature can only be exercised
        by waiting out a multi-minute countdown. Guards are the caller's job, as
        they are for the automatic path. */
    void forceLightStandby()
    {
        if (stage != Stage::active)
            return;

        stage = Stage::light;
        invoke (callbacks.enterLight);
        invoke (callbacks.stageChanged);
    }

    /** MainComponent cannot report the async rebuild through tick(), so it
        closes the loop here. A failed wake still returns to active: the rig is
        back (minus any plugin that could not be restored) and must not be left
        stuck in a state the user cannot leave. */
    void deepWakeFinished (juce::uint32 nowMs, bool)
    {
        if (stage != Stage::waking)
            return;

        stage = Stage::active;
        lastActivityMs = nowMs;
        invoke (callbacks.stageChanged);
    }

    /** An incoming rig apply owns the rack now: drop straight to active without
        running exitLight/beginWakeFromDeep, because the caller is already
        tearing the rack down and rebuilding it itself. */
    void abandon (juce::uint32 nowMs)
    {
        stage = Stage::active;
        started = true;
        lastActivityMs = nowMs;
        invoke (callbacks.stageChanged);
    }

private:
    static juce::uint32 toMs (double minutes) noexcept
    {
        return static_cast<juce::uint32> (minutes * 60.0 * 1000.0);
    }

    /** Unsigned arithmetic, so the juce::uint32 millisecond counter's wrap at
        ~49.7 days yields the correct short interval rather than a huge one. */
    juce::uint32 elapsedMs (juce::uint32 nowMs) const noexcept
    {
        return static_cast<juce::uint32> (nowMs - lastActivityMs);
    }

    static void invoke (const std::function<void()>& callback)
    {
        if (callback)
            callback();
    }

    Config    config;
    Callbacks callbacks;
    Stage        stage          = Stage::active;
    juce::uint32 lastActivityMs = 0;
    bool         started        = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (StandbyController)
};

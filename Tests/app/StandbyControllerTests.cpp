#include <JuceHeader.h>

#include "StandbyController.h"

#include <iostream>

/*
    Headless coverage for Auto Standby's policy: stage timings, what counts as
    activity, and above all the ORDER of the transitions — enterLight before
    enterDeep, exactly one exitLight per wake, nothing at all while a deep wake
    is still rebuilding. The controller is deliberately free of JUCE Timers,
    audio and the rack, so all of that is driven here with a synthetic clock.
*/

namespace
{
    int failures = 0;

    void expect (bool condition, const char* what)
    {
        if (! condition)
        {
            ++failures;
            std::cerr << "FAIL " << what << "\n";
        }
    }

    constexpr juce::uint32 minutes (double m) { return (juce::uint32) (m * 60.0 * 1000.0); }

    /** A controller wired to record every callback, in order. */
    struct Harness
    {
        StandbyController controller;
        juce::StringArray calls;

        Harness()
        {
            controller.setCallbacks ({
                [this] { calls.add ("enterLight"); },
                [this] { calls.add ("exitLight"); },
                [this] { calls.add ("enterDeep"); },
                [this] { calls.add ("beginWake"); },
                [this] { /* stageChanged is a UI echo; not part of the order */ },
            });
        }

        void configure (bool enabled, double light, double deep, juce::uint32 now = 0)
        {
            StandbyController::Config config;
            config.enabled = enabled;
            config.lightAfterMinutes = light;
            config.deepAfterMinutes = deep;
            config.wakeThresholdDb = -60.0f;
            controller.setConfig (config, now);
        }

        /** A silent tick with a live, non-empty rack and no blockers. */
        void idle (juce::uint32 nowMs)
        {
            StandbyController::Tick tick;
            tick.nowMs = nowMs;
            tick.inputPeak = 0.0f;
            tick.blocked = false;
            tick.hasPlugins = true;
            controller.tick (tick);
        }

        void loud (juce::uint32 nowMs)
        {
            StandbyController::Tick tick;
            tick.nowMs = nowMs;
            tick.inputPeak = 0.5f; // well above -60 dBFS
            tick.blocked = false;
            tick.hasPlugins = true;
            controller.tick (tick);
        }

        void blocked (juce::uint32 nowMs)
        {
            StandbyController::Tick tick;
            tick.nowMs = nowMs;
            tick.inputPeak = 0.0f;
            tick.blocked = true;
            tick.hasPlugins = true;
            controller.tick (tick);
        }

        void empty (juce::uint32 nowMs)
        {
            StandbyController::Tick tick;
            tick.nowMs = nowMs;
            tick.inputPeak = 0.0f;
            tick.blocked = false;
            tick.hasPlugins = false;
            controller.tick (tick);
        }

        juce::String order() const { return calls.joinIntoString (","); }
        StandbyController::Stage stage() const { return controller.getStage(); }
    };

    using Stage = StandbyController::Stage;
}

static void testDisabledNeverSleeps()
{
    Harness h;
    h.configure (false, 1.0, 2.0);
    h.idle (0);
    h.idle (minutes (60));
    expect (h.stage() == Stage::active, "a disabled controller never leaves active");
    expect (h.order().isEmpty(), "a disabled controller fires no callbacks");
}

static void testLightThenDeep()
{
    Harness h;
    h.configure (true, 5.0, 30.0);
    h.idle (0);

    h.idle (minutes (4.9));
    expect (h.stage() == Stage::active, "no standby before the light timeout");

    h.idle (minutes (5.1));
    expect (h.stage() == Stage::light, "light standby engages at its timeout");
    expect (h.order() == "enterLight", "only enterLight has fired");

    h.idle (minutes (29));
    expect (h.stage() == Stage::light, "no deep standby before the deep timeout");

    h.idle (minutes (31));
    expect (h.stage() == Stage::deep, "deep standby engages at its timeout");
    expect (h.order() == "enterLight,enterDeep", "deep is never entered without light first");
}

static void testDeepDisabledStaysLight()
{
    Harness h;
    h.configure (true, 5.0, 0.0); // 0 = never go deep
    h.idle (0);
    h.idle (minutes (6));
    expect (h.stage() == Stage::light, "light still engages");
    h.idle (minutes (600));
    expect (h.stage() == Stage::light, "a zero deep timeout never parks the rig");
    expect (h.order() == "enterLight", "enterDeep never fires");
}

static void testLightDisabledNeverSleeps()
{
    Harness h;
    h.configure (true, 0.0, 0.0);
    h.idle (0);
    h.idle (minutes (600));
    expect (h.stage() == Stage::active, "a zero light timeout disables standby entirely");
}

static void testWakeOnInputPeak()
{
    Harness h;
    h.configure (true, 5.0, 30.0);
    h.idle (0);
    h.idle (minutes (6));
    expect (h.stage() == Stage::light, "asleep");

    h.loud (minutes (7));
    expect (h.stage() == Stage::active, "a signal above the threshold wakes light standby");
    expect (h.order() == "enterLight,exitLight", "exactly one exitLight per wake");

    // And the countdown restarts from the wake, not from the original silence.
    h.idle (minutes (11));
    expect (h.stage() == Stage::active, "the idle clock restarts on wake");
    h.idle (minutes (12.1));
    expect (h.stage() == Stage::light, "and runs down again from there");
}

static void testWakeFromDeepIsAsync()
{
    Harness h;
    h.configure (true, 1.0, 2.0);
    h.idle (0);
    h.idle (minutes (1.1));
    h.idle (minutes (2.1));
    expect (h.stage() == Stage::deep, "parked");

    h.loud (minutes (3));
    expect (h.stage() == Stage::waking, "a wake from deep enters the waking stage");
    expect (h.order() == "enterLight,enterDeep,beginWake", "the rebuild is kicked off once");

    // Ticks and further activity during the rebuild must not start a second one.
    h.loud (minutes (3.1));
    h.idle (minutes (3.2));
    h.controller.noteActivity (minutes (3.3));
    expect (h.stage() == Stage::waking, "the controller stays in waking until told otherwise");
    expect (h.order() == "enterLight,enterDeep,beginWake", "no second rebuild is started");

    h.controller.deepWakeFinished (minutes (4), true);
    expect (h.stage() == Stage::active, "the rebuild reports back to active");

    // exitLight must NOT fire on the way out of deep: the rebuild already
    // brought the rig up itself.
    expect (h.order() == "enterLight,enterDeep,beginWake", "a deep wake does not also run exitLight");
}

static void testFailedDeepWakeStillReturnsToActive()
{
    Harness h;
    h.configure (true, 1.0, 2.0);
    h.idle (0);
    h.idle (minutes (1.1));
    h.idle (minutes (2.1));
    h.controller.noteActivity (minutes (3));
    h.controller.deepWakeFinished (minutes (4), false);
    expect (h.stage() == Stage::active,
            "a wake that lost plugins still leaves a state the user can act from");
}

static void testBlockedCountsAsActivity()
{
    Harness h;
    h.configure (true, 5.0, 30.0);
    h.idle (0);

    // An open editor / running scan / rig load holds the countdown off.
    for (juce::uint32 t = minutes (1); t <= minutes (60); t += minutes (1))
        h.blocked (t);
    expect (h.stage() == Stage::active, "a blocked tick never falls asleep");

    // And it restarted the clock, so standby is a full timeout away.
    h.idle (minutes (63));
    expect (h.stage() == Stage::active, "the clock restarted from the last blocked tick");
    h.idle (minutes (66));
    expect (h.stage() == Stage::light, "once unblocked the countdown runs normally");
}

static void testEmptyRackNeverSleeps()
{
    Harness h;
    h.configure (true, 1.0, 2.0);
    h.empty (0);
    h.empty (minutes (60));
    expect (h.stage() == Stage::active, "an empty rack has nothing to reclaim");
}

static void testDisablingWakes()
{
    Harness h;
    h.configure (true, 1.0, 30.0);
    h.idle (0);
    h.idle (minutes (2));
    expect (h.stage() == Stage::light, "asleep");

    h.configure (false, 1.0, 30.0, minutes (3));
    expect (h.stage() == Stage::active, "switching the feature off wakes immediately");
    expect (h.order() == "enterLight,exitLight", "and runs the normal wake");
}

static void testDeepIsClampedToLight()
{
    // A deep timeout below the light one would otherwise skip stage 1.
    Harness h;
    h.configure (true, 10.0, 5.0);
    expect (h.controller.getConfig().deepAfterMinutes >= 10.0,
            "a deep timeout below the light one is clamped up");

    h.idle (0);
    h.idle (minutes (11));
    expect (h.order() == "enterLight", "light still runs first");
}

static void testShorteningTheTimeoutMidStandbyDoesNotSkipAStage()
{
    Harness h;
    h.configure (true, 5.0, 60.0);
    h.idle (0);
    h.idle (minutes (6));
    expect (h.stage() == Stage::light, "asleep");

    // The user drops the deep timeout below the elapsed idle time.
    h.configure (true, 5.0, 6.0, minutes (6));
    h.idle (minutes (7));
    expect (h.stage() == Stage::deep, "deep engages on the next tick, from light");
    expect (h.order() == "enterLight,enterDeep", "and still never skips light");
}

static void testMillisecondCounterWraparound()
{
    // juce::Time::getMillisecondCounter() wraps every ~49.7 days. Unsigned
    // arithmetic must yield the short interval, not a 49-day one.
    Harness h;
    h.configure (true, 5.0, 0.0);

    const juce::uint32 beforeWrap = 0xFFFFFFFFu - minutes (1);
    h.idle (beforeWrap);
    expect (h.stage() == Stage::active, "no immediate sleep just before the wrap");

    // 2 minutes later, having wrapped past zero: still under the 5-minute mark.
    h.idle (beforeWrap + minutes (2));
    expect (h.stage() == Stage::active, "an interval spanning the wrap is not treated as huge");

    h.idle (beforeWrap + minutes (6));
    expect (h.stage() == Stage::light, "and the real timeout still fires across the wrap");
}

static void testForceLightStandby()
{
    Harness h;
    h.configure (true, 500.0, 0.0);
    h.idle (0);

    h.controller.forceLightStandby();
    expect (h.stage() == Stage::light, "sleep-now bypasses the countdown");
    expect (h.order() == "enterLight", "and runs the normal entry");

    h.controller.forceLightStandby();
    expect (h.order() == "enterLight", "forcing again while asleep is a no-op");

    h.controller.noteActivity (minutes (1));
    expect (h.stage() == Stage::active, "and it wakes normally");
}

static void testAbandonSkipsTheWake()
{
    // A rig apply owns the rack and rebuilds it itself, so the controller must
    // drop to active WITHOUT running exitLight or beginWake.
    Harness h;
    h.configure (true, 1.0, 2.0);
    h.idle (0);
    h.idle (minutes (1.1));
    expect (h.stage() == Stage::light, "asleep");

    h.controller.abandon (minutes (2));
    expect (h.stage() == Stage::active, "abandon returns to active");
    expect (h.order() == "enterLight", "abandon runs no wake callbacks");
}

int main()
{
    // No ScopedJuceInitialiser: the controller is pure policy over juce_core
    // types, with no message loop, audio device or GUI behind it.
    testDisabledNeverSleeps();
    testLightThenDeep();
    testDeepDisabledStaysLight();
    testLightDisabledNeverSleeps();
    testWakeOnInputPeak();
    testWakeFromDeepIsAsync();
    testFailedDeepWakeStillReturnsToActive();
    testBlockedCountsAsActivity();
    testEmptyRackNeverSleeps();
    testDisablingWakes();
    testDeepIsClampedToLight();
    testShorteningTheTimeoutMidStandbyDoesNotSkipAStage();
    testMillisecondCounterWraparound();
    testForceLightStandby();
    testAbandonSkipsTheWake();

    if (failures != 0)
        return 1;

    std::cout << "StandbyController: all policy cases passed\n";
    return 0;
}

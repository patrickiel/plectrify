#include <JuceHeader.h>

#include "NoiseGate.h"

#include <cmath>
#include <functional>
#include <iostream>
#include <vector>

/*
    Headless coverage for the built-in noise gate against synthetic signals.
    Blocks are fed exactly as the input router feeds them; no graph or device
    is involved. Timing assertions are deliberately loose bounds rather than
    exact sample counts — the detector's exponential decay and the hold are
    what they are, and a test that pinned them to the sample would only ever
    break on a retune, not on a bug.
*/

namespace
{
    constexpr double rate = 48000.0;
    constexpr int blockSize = 256;
    int failures = 0;

    void expect (bool condition, const char* what)
    {
        if (! condition)
        {
            ++failures;
            std::cerr << "FAIL " << what << "\n";
        }
    }

    float dbToGain (float db) { return juce::Decibels::decibelsToGain (db); }
    float gainToDb (float gain) { return juce::Decibels::gainToDecibels (gain, -200.0f); }

    struct Run
    {
        std::vector<float> in, out, out1;
    };

    /** Runs the gate over `seconds` of a signal described per sample on channel
        0, with channel 1 carrying half of it, so one pass checks both that the
        gain is shared and what it was. */
    Run run (NoiseGate& gate, double seconds, const std::function<float (int)>& signal)
    {
        Run result;
        const int total = (int) (seconds * rate);
        juce::AudioBuffer<float> buffer (2, blockSize);
        for (int start = 0; start < total; start += blockSize)
        {
            const int n = juce::jmin (blockSize, total - start);
            buffer.setSize (2, n, false, false, true);
            for (int i = 0; i < n; ++i)
            {
                const float x = signal (start + i);
                buffer.setSample (0, i, x);
                buffer.setSample (1, i, 0.5f * x);
                result.in.push_back (x);
            }
            gate.process (buffer);
            for (int i = 0; i < n; ++i)
            {
                result.out.push_back (buffer.getSample (0, i));
                result.out1.push_back (buffer.getSample (1, i));
            }
        }
        return result;
    }

    std::function<float (int)> sine (float peak, float hz)
    {
        return [=] (int i) { return peak * (float) std::sin (2.0 * juce::MathConstants<double>::pi * hz * i / rate); };
    }

    float peakIn (const std::vector<float>& v, int start, int length)
    {
        float m = 0.0f;
        for (int i = start; i < juce::jmin ((int) v.size(), start + length); ++i)
            m = juce::jmax (m, std::abs (v[(size_t) i]));
        return m;
    }

    int samples (double seconds) { return (int) (seconds * rate); }

    /** First sample at which the gate attenuates by more than `db`. */
    int firstAttenuatedBeyond (const Run& r, float db, int from = 0)
    {
        const float ratio = dbToGain (-db);
        for (int i = from; i < (int) r.in.size(); ++i)
        {
            const float x = std::abs (r.in[(size_t) i]);
            if (x > 1.0e-4f && std::abs (r.out[(size_t) i]) < x * ratio)
                return i;
        }
        return -1;
    }

    void testDisabledGateIsTransparent()
    {
        NoiseGate gate;
        gate.prepare (rate);
        const auto r = run (gate, 0.5, sine (dbToGain (-60.0f), 220.0f));
        bool identical = true;
        for (size_t i = 0; i < r.in.size(); ++i)
            identical = identical && r.out[i] == r.in[i] && r.out1[i] == 0.5f * r.in[i];
        expect (identical, "a disabled gate changes nothing, however quiet the input");
        expect (gate.getReductionDb() == 0.0f, "a disabled gate reports no reduction");
    }

    void testSignalAboveThresholdPassesAtUnity()
    {
        NoiseGate gate;
        gate.prepare (rate);
        gate.setEnabled (true);
        gate.setThresholdDb (-50.0f);
        const auto r = run (gate, 0.5, sine (dbToGain (-20.0f), 110.0f));
        // Past the attack (2 ms) the gain is exactly one, and one is not
        // multiplied in — so the samples are bit-identical, not merely close.
        bool identical = true;
        for (size_t i = (size_t) samples (0.005); i < r.in.size(); ++i)
            identical = identical && r.out[i] == r.in[i];
        expect (identical, "a note above the threshold passes untouched once the gate has opened");
        expect (gate.getReductionDb() == 0.0f, "an open gate reports no reduction");
        expect (gate.isOpen(), "an open gate reports open");
    }

    void testHumBelowThresholdIsPushedDown()
    {
        NoiseGate gate;
        gate.prepare (rate);
        gate.setEnabled (true);
        gate.setThresholdDb (-50.0f);
        gate.setShape (NoiseGate::Shape::firm);
        gate.setRangeDb (70.0f);
        // Mains hum 15 dB under the threshold, 9 dB under the close threshold:
        // the firm slope asks for 36 dB of attenuation, which the ramp reaches
        // comfortably inside a second even allowing for detector ripple.
        const auto r = run (gate, 1.0, sine (dbToGain (-65.0f), 60.0f));
        const float late = peakIn (r.out, samples (0.8), samples (0.2));
        const float attenuation = gainToDb (dbToGain (-65.0f)) - gainToDb (late);
        expect (attenuation >= 30.0f, "hum below the threshold is attenuated by at least 30 dB");
        expect (attenuation <= NoiseGate::maxRangeDb + 1.0f, "attenuation never exceeds the range floor");
        expect (gate.getReductionDb() <= -30.0f, "a closed gate reports its reduction");
        expect (! gate.isOpen(), "a closed gate reports closed");

        bool shared = true;
        for (size_t i = 0; i < r.out.size(); ++i)
            shared = shared && std::abs (r.out1[i] - 0.5f * r.out[i]) <= 1.0e-6f;
        expect (shared, "both channels receive the same gain");
    }

    void testStoppedNoteWaitsOutHoldThenFades()
    {
        // A note, then the string is stopped: the signal drops to a floor well
        // under the close threshold. The gate must stay open through the hold,
        // then fall no faster than the release rate.
        auto noteThenFloor = [] (int i)
        {
            const float peak = i < samples (0.25) ? dbToGain (-20.0f) : dbToGain (-75.0f);
            return peak * (float) std::sin (2.0 * juce::MathConstants<double>::pi * 110.0 * i / rate);
        };

        NoiseGate shortHold;
        shortHold.prepare (rate);
        shortHold.setEnabled (true);
        shortHold.setThresholdDb (-50.0f);
        shortHold.setHoldMs (0.0f);
        shortHold.setReleaseMs (150.0f);
        const auto quick = run (shortHold, 1.5, noteThenFloor);

        const int drop = samples (0.25);
        const int closeStart = firstAttenuatedBeyond (quick, 1.0f, drop);
        expect (closeStart > drop, "the gate starts closing only after the note stops");
        // The detector has to fall 36 dB first (about 80 ms at a 20 ms time
        // constant) — an immediate close would clip every note's tail.
        expect (closeStart - drop >= samples (0.04), "closing waits for the detector, not the first quiet sample");
        expect (closeStart - drop <= samples (0.3), "a stopped note is noticed within 300 ms with no hold");

        const float floorLate = peakIn (quick.out, samples (1.3), samples (0.2));
        expect (gainToDb (dbToGain (-75.0f)) - gainToDb (floorLate) >= 40.0f,
                "the floor after a note ends up attenuated");

        // Release rate: the gain must never fall faster than range/release per
        // sample. Measured away from zero crossings, where the ratio is exact.
        const float maxStepDb = shortHold.getRangeDb() / (float) (rate * 0.150) + 1.0e-3f;
        bool paced = true;
        float previousDb = 0.0f;
        int previousIndex = -1;
        for (int i = drop; i < (int) quick.in.size(); ++i)
        {
            const float x = std::abs (quick.in[(size_t) i]);
            if (x < 0.5f * dbToGain (-75.0f)) continue;
            const float g = gainToDb (std::abs (quick.out[(size_t) i]) / x);
            if (previousIndex >= 0 && previousDb - g > maxStepDb * (float) (i - previousIndex))
                paced = false;
            previousDb = g;
            previousIndex = i;
        }
        expect (paced, "the gain never falls faster than the release rate");

        NoiseGate longHold;
        longHold.prepare (rate);
        longHold.setEnabled (true);
        longHold.setThresholdDb (-50.0f);
        longHold.setHoldMs (400.0f);
        longHold.setReleaseMs (150.0f);
        const auto held = run (longHold, 1.5, noteThenFloor);
        const int heldCloseStart = firstAttenuatedBeyond (held, 1.0f, drop);
        expect (heldCloseStart > closeStart, "a longer hold closes later");
        const int extra = heldCloseStart - closeStart;
        expect (extra >= samples (0.37) && extra <= samples (0.43),
                "the hold adds its own length to the close, within a block or two");
    }

    void testControlsAreClamped()
    {
        NoiseGate gate;
        gate.setThresholdDb (5.0f);
        expect (gate.getThresholdDb() == NoiseGate::maxThresholdDb, "threshold clamps at its ceiling");
        gate.setThresholdDb (-200.0f);
        expect (gate.getThresholdDb() == NoiseGate::minThresholdDb, "threshold clamps at its floor");
        gate.setHoldMs (-1.0f);
        expect (gate.getHoldMs() == NoiseGate::minHoldMs, "hold clamps at zero");
        gate.setReleaseMs (0.0f);
        expect (gate.getReleaseMs() == NoiseGate::minReleaseMs, "release clamps at its floor");
        gate.setAttackMs (0.0f);
        expect (juce::exactlyEqual (gate.getAttackMs(), NoiseGate::minAttackMs), "attack clamps at its floor");
        gate.setRangeDb (500.0f);
        expect (juce::exactlyEqual (gate.getRangeDb(), NoiseGate::maxRangeDb), "range clamps at its ceiling");
        gate.setShape (7);
        expect (gate.getShape() == NoiseGate::defaultShape, "an unknown shape reads as the default");
    }

    void testDisablingMidNoteRampsBackToUnity()
    {
        NoiseGate gate;
        gate.prepare (rate);
        gate.setEnabled (true);
        gate.setThresholdDb (-50.0f);
        gate.setAttackMs (NoiseGate::minAttackMs);
        run (gate, 0.5, sine (dbToGain (-65.0f), 60.0f));
        expect (gate.getReductionDb() < -20.0f, "precondition: the gate is closed over the hum");
        gate.setEnabled (false);
        const auto r = run (gate, 0.1, sine (dbToGain (-65.0f), 60.0f));
        // The switch has its own ramp, slower than any attack: still fading
        // one block in, back to bit-identical well before 100 ms.
        expect (std::abs (r.out[(size_t) blockSize / 2]) < std::abs (r.in[(size_t) blockSize / 2]) * 0.999f
                    || std::abs (r.in[(size_t) blockSize / 2]) < 1.0e-5f,
                "switching the gate off is a fade, not a step");
        bool identicalLate = true;
        for (size_t i = (size_t) samples (0.05); i < r.in.size(); ++i)
            identicalLate = identicalLate && juce::exactlyEqual (r.out[i], r.in[i]);
        expect (identicalLate, "switching the gate off reaches unity within the switch ramp");
        expect (juce::exactlyEqual (gate.getReductionDb(), 0.0f), "a gate switched off reports no reduction");
        expect (gate.isOpen(), "a gate switched off reports open");
    }

    void testEnablingInsideHysteresisKeepsTheNote()
    {
        // A note sustaining 3 dB under the threshold — inside the hysteresis
        // band — while the gate is off. Switching it on must find the gate open
        // and leave the note alone, even with the hard shape that would send a
        // closed gate straight to the floor.
        NoiseGate gate;
        gate.prepare (rate);
        gate.setThresholdDb (-50.0f);
        gate.setShape (NoiseGate::Shape::hard);
        const auto note = sine (dbToGain (-53.0f), 110.0f);
        run (gate, 0.3, note);
        gate.setEnabled (true);
        const auto r = run (gate, 0.3, note);
        bool identical = true;
        for (size_t i = 0; i < r.in.size(); ++i)
            identical = identical && juce::exactlyEqual (r.out[i], r.in[i]);
        expect (identical, "switching on over a note inside the hysteresis band leaves it untouched");
        expect (gate.isOpen(), "a gate switched on over a note in the band reports open");
    }

    void testShapeAndRangeSetTheFloor()
    {
        // The same hum, 9 dB under the close threshold, under each shape: soft
        // asks for 18 dB, firm for 36, hard for the whole range. Range caps all
        // three, so a 10 dB range turns even hard into a duck.
        auto settle = [] (NoiseGate::Shape shape, float range)
        {
            NoiseGate gate;
            gate.prepare (rate);
            gate.setEnabled (true);
            gate.setThresholdDb (-50.0f);
            gate.setShape (shape);
            gate.setRangeDb (range);
            run (gate, 1.5, sine (dbToGain (-65.0f), 60.0f));
            return gate.getReductionDb();
        };
        const float soft = settle (NoiseGate::Shape::soft, 70.0f);
        const float firm = settle (NoiseGate::Shape::firm, 70.0f);
        const float hard = settle (NoiseGate::Shape::hard, 70.0f);
        expect (soft > -24.0f && soft < -12.0f, "soft eases the floor down by its slope");
        expect (firm > -44.0f && firm < -28.0f, "firm pushes twice as hard");
        expect (hard <= -69.0f, "hard goes straight to the range floor");
        expect (settle (NoiseGate::Shape::hard, 10.0f) >= -10.5f, "range caps how far any shape closes");
        expect (settle (NoiseGate::Shape::firm, 20.0f) >= -20.5f, "range caps the slope too");
    }

    void testAttackPacesTheOpening()
    {
        // From a closed hard gate, a note arriving: with a 20 ms attack the
        // gain must still be well short of unity 5 ms in and at unity by 30 ms.
        auto floorThenNote = [] (int i)
        {
            const float peak = i < samples (0.5) ? dbToGain (-75.0f) : dbToGain (-20.0f);
            return peak * (float) std::sin (2.0 * juce::MathConstants<double>::pi * 110.0 * i / rate);
        };
        NoiseGate gate;
        gate.prepare (rate);
        gate.setEnabled (true);
        gate.setThresholdDb (-50.0f);
        gate.setShape (NoiseGate::Shape::hard);
        gate.setRangeDb (50.0f);
        gate.setAttackMs (20.0f);
        const auto r = run (gate, 0.6, floorThenNote);
        const int onset = samples (0.5);
        const float early = peakIn (r.out, onset + samples (0.004), samples (0.002));
        const float late = peakIn (r.out, onset + samples (0.03), samples (0.02));
        expect (gainToDb (early) < gainToDb (dbToGain (-20.0f)) - 20.0f,
                "5 ms into a 20 ms attack the gain is still far below unity");
        expect (juce::exactlyEqual (gainToDb (late), gainToDb (dbToGain (-20.0f))) || late >= dbToGain (-20.0f) * 0.999f,
                "by 30 ms the gate is fully open");
    }
}

int main()
{
    testDisabledGateIsTransparent();
    testSignalAboveThresholdPassesAtUnity();
    testHumBelowThresholdIsPushedDown();
    testStoppedNoteWaitsOutHoldThenFades();
    testControlsAreClamped();
    testDisablingMidNoteRampsBackToUnity();
    testEnablingInsideHysteresisKeepsTheNote();
    testShapeAndRangeSetTheFloor();
    testAttackPacesTheOpening();

    if (failures > 0)
    {
        std::cerr << failures << " failure(s)\n";
        return 1;
    }
    std::cout << "NoiseGate tests passed\n";
    return 0;
}

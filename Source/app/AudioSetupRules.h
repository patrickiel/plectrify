#pragma once

#include <JuceHeader.h>

/**
    What Plectrify opens when nobody has told it what to open.

    A first launch has no audio_settings.xml and therefore no answer to the two
    questions that decide whether the app makes a sound at all: which driver
    family, and how big a block. JUCE's own default is "whatever the OS calls
    default", which on Windows is shared-mode WASAPI against the machine's
    built-in devices — a webcam microphone at thirty milliseconds. That is not a
    guitar rig, and a player who hears that first has already decided what the
    app is.

    So these are the rules the engine applies to a device it chose itself, and
    the same ones the setup wizard marks as "recommended" when the user is
    choosing by hand. Pure functions with no device manager in sight, so the
    reasoning is one testable statement rather than a condition buried in the
    audio stack (see Tests/app/AudioSetupRulesTests.cpp).
*/
namespace plectrify::audiosetup
{
    /** Driver families we would rather open than the OS default, best first.
        ASIO is the only one on Windows that talks to the interface directly;
        everything else on that list is a shared mixer with a buffer of its own
        on top of ours. macOS has no such split — CoreAudio *is* the low-latency
        path — so its single type is chosen by the fallback below rather than by
        name. */
    inline const juce::StringArray& preferredDeviceTypes()
    {
        static const juce::StringArray types { "ASIO" };
        return types;
    }

    /** The driver family a fresh installation should open.

        The first preferred family the machine actually offers, and otherwise
        the first family it offers at all — which is JUCE's own default and, on
        macOS, the only one there is. Empty in, empty out: a machine with no
        audio driver has nothing to choose. */
    inline juce::String preferredDeviceType (const juce::StringArray& available)
    {
        for (const auto& preferred : preferredDeviceTypes())
            for (const auto& type : available)
                if (type.equalsIgnoreCase (preferred))
                    return type;   // the machine's own spelling, not ours

        return available.isEmpty() ? juce::String() : available[0];
    }

    /** How long a block lasts, in milliseconds. */
    inline double bufferMilliseconds (int bufferSize, double sampleRate)
    {
        return sampleRate > 0.0 ? 1000.0 * (double) bufferSize / sampleRate : 0.0;
    }

    /** The smallest block a first launch should ask for.

        Deliberately not the smallest the device offers. A first run knows
        nothing about the machine it is on — the CPU, the driver, whatever else
        is running — and the two ways of being wrong are not symmetrical: a
        buffer that is too large feels slightly slow and still plays, while one
        that is too small crackles, and a rig that crackles reads as a broken
        app rather than as a setting. So aim at the first size that lasts at
        least `targetMs`, which on any normal device is 256 samples, and let the
        wizard's latency step take it lower against a meter that shows the
        result.

        A device offering nothing at all keeps JUCE's own default (0 means "no
        opinion", which setAudioDeviceSetup reads as leave-it-alone). */
    inline int preferredBufferSize (const juce::Array<int>& available, double sampleRate,
                                    double targetMs = 5.0)
    {
        if (available.isEmpty())
            return 0;

        auto sorted = available;
        sorted.sort();

        for (const auto size : sorted)
            if (bufferMilliseconds (size, sampleRate) >= targetMs)
                return size;

        // Every size on offer is shorter than the target: take the longest,
        // which is the closest this device can come to being safe.
        return sorted.getLast();
    }
}

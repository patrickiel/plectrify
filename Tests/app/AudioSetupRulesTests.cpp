#include <JuceHeader.h>

#include "AudioSetupRules.h"

#include <iostream>

/*
    The rules a first launch opens an audio device by. Both are one-liners with
    no device manager in them precisely so they can be pinned here: what they
    decide is the difference between a guitarist hearing their guitar and a
    guitarist hearing a webcam microphone thirty milliseconds late.
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

    void expectEquals (int actual, int expected, const char* what)
    {
        if (actual != expected)
        {
            ++failures;
            std::cerr << "FAIL " << what << " — got " << actual << ", expected " << expected << "\n";
        }
    }

    void expectEquals (const juce::String& actual, const juce::String& expected, const char* what)
    {
        if (actual != expected)
        {
            ++failures;
            std::cerr << "FAIL " << what << " — got \"" << actual << "\", expected \""
                      << expected << "\"\n";
        }
    }

    using namespace plectrify::audiosetup;

    void testDeviceType()
    {
        // The whole point on Windows: ASIO talks to the interface, everything
        // else is a shared mixer with a buffer of its own on top of ours.
        expectEquals (preferredDeviceType ({ "Windows Audio", "DirectSound", "ASIO" }),
                      "ASIO", "ASIO wins wherever it appears in the list");

        // The machine's spelling, not ours — the string is handed straight back
        // to setCurrentAudioDeviceType, which matches exactly.
        expectEquals (preferredDeviceType ({ "Windows Audio", "asio" }),
                      "asio", "the type is returned as the host spelled it");

        // macOS has one type and it *is* the low-latency path, so the fallback
        // rather than the preference list is what chooses it.
        expectEquals (preferredDeviceType ({ "CoreAudio" }),
                      "CoreAudio", "a single type is chosen by the fallback");

        expectEquals (preferredDeviceType ({ "Windows Audio", "DirectSound" }),
                      "Windows Audio", "no preferred family: the host's own first choice");

        expect (preferredDeviceType ({}).isEmpty(), "no drivers at all: nothing to choose");
    }

    void testBufferSize()
    {
        const juce::Array<int> typical { 32, 64, 128, 256, 512, 1024, 2048 };

        // 256 at 48 k is 5.3 ms: the first size that clears the target. Not the
        // smallest on offer — a first run knows nothing about the machine, and
        // a rig that crackles reads as a broken app rather than as a setting.
        expectEquals (preferredBufferSize (typical, 48000.0), 256,
                      "48 kHz picks the first size at or over the target");
        expectEquals (preferredBufferSize (typical, 44100.0), 256,
                      "44.1 kHz picks the same block");
        // Twice the rate is half the time per block, so the safe answer doubles.
        expectEquals (preferredBufferSize (typical, 96000.0), 512,
                      "96 kHz needs twice the samples for the same milliseconds");

        // Order is not something a driver promises.
        expectEquals (preferredBufferSize ({ 1024, 128, 512, 256 }, 48000.0), 256,
                      "an unsorted list is still answered by duration");

        // A device whose largest block is under the target: take the longest it
        // has, which is as safe as that device can be.
        expectEquals (preferredBufferSize ({ 32, 64 }, 48000.0), 64,
                      "every size below the target falls back to the longest");

        // One size on offer is not a choice.
        expectEquals (preferredBufferSize ({ 480 }, 48000.0), 480,
                      "a single offered size is taken whatever it lasts");

        // 0 means "no opinion", which setAudioDeviceSetup reads as leave-alone.
        expectEquals (preferredBufferSize ({}, 48000.0), 0,
                      "no sizes offered leaves JUCE's own default in place");

        // A device that has not reported a rate yet must not divide by zero.
        expectEquals (preferredBufferSize (typical, 0.0), 2048,
                      "an unknown sample rate falls back to the longest block");
    }
}

int main()
{
    testDeviceType();
    testBufferSize();

    if (failures == 0)
        std::cout << "AudioSetupRules tests passed\n";

    return failures == 0 ? 0 : 1;
}

#include <JuceHeader.h>

#include "AudioSetupRules.h"
#include "PipeWireJack.h"

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

        // Linux: JACK (PipeWire's, usually) over raw ALSA, whatever JUCE's order.
        expectEquals (preferredDeviceType ({ "ALSA", "JACK" }),
                      "JACK", "JACK wins over ALSA");

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

    void testInputChannels()
    {
        expectEquals (inputChannelsToOpen (2), 2, "a real interface opens every jack");
        expectEquals (inputChannelsToOpen (128), maxOpenedInputChannels,
                      "PipeWire's 128 virtual inputs are capped");
        expectEquals (inputChannelsToOpen (0), 0, "no inputs, none opened");
    }
}

//==============================================================================
// Which JACK JUCE is pointed at on a PipeWire desktop, from the environment
// PipeWire itself reads — never from the machine the test runs on.
void testPipeWireJack()
{
    using namespace plectrify::pipewirejack;

    expectEquals (socketPath ({}, {}, "/run/user/1000", "/run/user/0"),
                  "/run/user/1000/pipewire-0", "the socket is pipewire-0 under XDG_RUNTIME_DIR");
    expectEquals (socketPath ({}, "/tmp/pw", "/run/user/1000", "/run/user/0"),
                  "/tmp/pw/pipewire-0", "PIPEWIRE_RUNTIME_DIR wins over XDG_RUNTIME_DIR");
    expectEquals (socketPath ({}, {}, {}, "/run/user/1000"),
                  "/run/user/1000/pipewire-0", "no runtime dir in the environment falls back to /run/user/<uid>");
    expectEquals (socketPath ("pipewire-1", {}, "/run/user/1000", {}),
                  "/run/user/1000/pipewire-1", "PIPEWIRE_REMOTE names the socket");
    expectEquals (socketPath ("/srv/pw/sock", "/tmp/pw", "/run/user/1000", {}),
                  "/srv/pw/sock", "an absolute PIPEWIRE_REMOTE is the socket");
    expect (socketPath ({}, {}, {}, {}).isEmpty(), "nothing to go on is no socket, not a relative path");

    const juce::StringArray candidates { "/a/libjack.so.0", "/b/libjack.so.0" };
    const auto onlyB = [] (const juce::String& path) { return path.startsWith ("/b/"); };
    const auto all   = [] (const juce::String&) { return true; };
    const auto none  = [] (const juce::String&) { return false; };

    expectEquals (chooseLibrary (true, candidates, all), "/a/libjack.so.0", "the first candidate that exists");
    expectEquals (chooseLibrary (true, candidates, onlyB), "/b/libjack.so.0", "a missing first candidate is skipped");
    expectEquals (chooseLibrary (true, candidates, none), juce::String(), "no library installed loads nothing");
    expectEquals (chooseLibrary (false, candidates, all), juce::String(),
                  "PipeWire not running loads nothing, so a real jackd keeps its own JACK");

    expect (libraryCandidates().size() >= 3, "the known distribution paths are all tried");
    for (const auto& candidate : libraryCandidates())
        expect (candidate.endsWith ("/pipewire-0.3/jack/libjack.so.0"), "every candidate is PipeWire's JACK, by its soname");
}

int main()
{
    testDeviceType();
    testBufferSize();
    testInputChannels();
    testPipeWireJack();

    if (failures == 0)
        std::cout << "AudioSetupRules tests passed\n";

    return failures == 0 ? 0 : 1;
}

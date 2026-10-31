#pragma once

#include <JuceHeader.h>

#include <functional>

#if JUCE_LINUX
 #include <dlfcn.h>
 #include <unistd.h>
#endif

/**
    Points JUCE's JACK device type at PipeWire's JACK on a desktop that runs
    PipeWire — which on Linux is the one driver family that shares the interface
    with every other application at the block size the player chose (see
    audiosetup::preferredDeviceTypes). ALSA, the alternative, either opens the
    hardware exclusively, silencing the rest of the desktop for as long as the
    app runs, or goes through PipeWire's own buffer.

    The catch is which libjack JUCE finds. It dlopen()s "libjack.so.0" by name,
    which the loader resolves through its default path — and distributions keep
    PipeWire's JACK *out* of that path on purpose (Debian and Ubuntu ship the
    ld.so.conf fragment enabling it only as an example under /usr/share/doc), so
    that an installed jackd stays the system's JACK. On a stock Ubuntu desktop
    the name therefore lands on jackd2's client library, which finds no jackd
    running, so the JACK type lists no device and the first-run choice falls
    back to ALSA. That is how a Scarlett came to be held exclusively, with the
    user's browser silent, on the machine this was written on.

    So, before the device manager creates its types, load PipeWire's library by
    its full path. glibc matches a later dlopen() by soname against what is
    already loaded, so JUCE's "libjack.so.0" then resolves to this copy with no
    change to JUCE and no loader configuration on the user's machine. It is
    done only while PipeWire is actually running (its socket exists): a machine
    running a real jackd and no PipeWire keeps its own JACK, and a machine with
    neither keeps today's behaviour. The handle is deliberately never closed.

    The rules are pure functions over the environment so they can be pinned in
    Tests/app/AudioSetupRulesTests.cpp; preferPipeWireJack() is the one call
    with a side effect, and a no-op off Linux.
*/
namespace plectrify::pipewirejack
{
    /** Where PipeWire's socket is, from the same environment PipeWire reads:
        PIPEWIRE_REMOTE names the socket (an absolute path is used as given),
        else "pipewire-0" inside PIPEWIRE_RUNTIME_DIR, else XDG_RUNTIME_DIR,
        else the caller's fallback (/run/user/<uid>). A POSIX path as a string,
        empty when there is nothing to go on: this is a rule about a Unix
        socket, so it is pure on every OS and juce::File (which would read the
        same text as a Windows path) only enters on the Linux caller's side. */
    inline juce::String socketPath (const juce::String& pipewireRemote,
                                    const juce::String& pipewireRuntimeDir,
                                    const juce::String& xdgRuntimeDir,
                                    const juce::String& fallbackRuntimeDir)
    {
        const auto name = pipewireRemote.isNotEmpty() ? pipewireRemote : juce::String ("pipewire-0");

        if (name.startsWithChar ('/'))
            return name;

        const auto dir = pipewireRuntimeDir.isNotEmpty() ? pipewireRuntimeDir
                       : xdgRuntimeDir.isNotEmpty()      ? xdgRuntimeDir
                                                         : fallbackRuntimeDir;

        if (dir.isEmpty())
            return {};

        return dir.endsWithChar ('/') ? dir + name : dir + "/" + name;
    }

    /** Where distributions install PipeWire's JACK, in the order tried. These
        are the directories the pipewire-jack packages ship it in and keep out
        of the loader's default path; x86-64 only, like the build. */
    inline const juce::StringArray& libraryCandidates()
    {
        static const juce::StringArray candidates {
            "/usr/lib/x86_64-linux-gnu/pipewire-0.3/jack/libjack.so.0",   // Debian, Ubuntu
            "/usr/lib64/pipewire-0.3/jack/libjack.so.0",                  // Fedora, openSUSE
            "/usr/lib/pipewire-0.3/jack/libjack.so.0",                    // Arch
        };
        return candidates;
    }

    /** The library to load, or empty: the first candidate that exists, and
        only while PipeWire is running — without it PipeWire's JACK could open
        nothing, and a real jackd the user runs instead would be hidden. */
    inline juce::String chooseLibrary (bool pipeWireRunning,
                                       const juce::StringArray& candidates,
                                       const std::function<bool (const juce::String&)>& exists)
    {
        if (! pipeWireRunning)
            return {};

        for (const auto& candidate : candidates)
            if (exists (candidate))
                return candidate;

        return {};
    }

    /** Loads PipeWire's JACK ahead of JUCE's lookup, per the rules above.
        Returns the path loaded, or empty when nothing was (off Linux, no
        PipeWire, no library, or dlopen refused it). Call before the audio
        device manager creates its device types. */
    inline juce::String preferPipeWireJack()
    {
       #if JUCE_LINUX
        const auto env = [] (const char* name) { return juce::SystemStats::getEnvironmentVariable (name, {}); };
        const auto socket = socketPath (env ("PIPEWIRE_REMOTE"),
                                        env ("PIPEWIRE_RUNTIME_DIR"),
                                        env ("XDG_RUNTIME_DIR"),
                                        "/run/user/" + juce::String ((int) getuid()));

        const auto library = chooseLibrary (socket.isNotEmpty() && juce::File (socket).exists(),
                                            libraryCandidates(),
                                            [] (const juce::String& path) { return juce::File (path).existsAsFile(); });

        if (library.isEmpty())
            return {};

        // Kept for the life of the process: JUCE's own handle is this one.
        static void* handle = nullptr;
        if (handle == nullptr)
            handle = dlopen (library.toRawUTF8(), RTLD_LAZY);

        return handle != nullptr ? library : juce::String();
       #else
        return {};
       #endif
    }
}

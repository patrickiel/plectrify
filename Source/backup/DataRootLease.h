#pragma once

#include <JuceHeader.h>

#if JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #include <windows.h>
#else
 #include <fcntl.h>
 #include <sys/file.h>
 #include <unistd.h>
#endif

/**
    Who else is using the per-user data root right now.

    The standalone and the plugin read and write the same root
    (plectrify::appDataDir()), so a reset scheduled by the standalone would pull
    settings.json, the patches and the rigs out from under a Plectrify instance
    running inside a DAW at that moment — which still holds all of it in memory
    and writes it straight back on its next autosave, half-restoring the root
    the user just asked to have wiped. HostCapabilities::backup only hides the
    Reset row inside the DAW; it says nothing about what the standalone may do
    while a DAW is open.

    So every plugin instance holds a DataRootLease — a *shared* lock on one file
    beside the data — and the standalone asks dataRootInUseElsewhere() before it
    schedules a reset, by trying for the *exclusive* lock without waiting. Any
    number of leases coexist; the probe fails while even one is held. The OS
    releases a lock with its handle, so a DAW that crashes or is killed takes
    its leases with it.

    Why not juce::InterProcessLock. Its POSIX half is an fcntl lock and its
    Windows half a named mutex, and both are owned by the *process* (or the
    thread), not by the handle: a second lock on the same name in the same
    process is granted at once, and closing either releases it for everyone.
    That is not a corner case here — a mac DAW that loads Plectrify.vst3 on one
    track and Plectrify.component on another has one copy of every static per
    bundle, so "one lease per process" cannot be arranged, and removing the AU
    would have freed the root under the still-running VST3. And an exclusive
    lock cannot count: a second DAW finding it taken held nothing, and became
    invisible to the probe the moment the first quit. flock() on POSIX and
    LockFileEx() on Windows are both per open handle, and both have a shared
    mode, which is exactly the shape of the question — "is anyone holding
    this?" rather than "may I have it?".

    The lock file lives in the data root itself, beside what it protects, so
    the standalone and every plugin bundle agree on it without a second path
    convention. It is not a reset target (AppReset.h) and holds no data.

    Header-only, so the plugin compiles it without AppReset.cpp, which stays
    standalone-only.
*/
namespace plectrify
{

/** The lock file for a given data root. */
inline juce::File dataRootLockFile (const juce::File& dataRoot)
{
    return dataRoot.getChildFile ("data-root.lock");
}

namespace detail
{
#if JUCE_WINDOWS
using LockHandle = HANDLE;
inline LockHandle invalidLockHandle() { return INVALID_HANDLE_VALUE; }

inline LockHandle openLockFile (const juce::File& file)
{
    file.getParentDirectory().createDirectory();
    return CreateFileW (file.getFullPathName().toWideCharPointer(),
                        GENERIC_READ | GENERIC_WRITE,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
}

/** Locks the file's first byte; a byte-range lock needs a range, and one
    byte is as good as the file. Never waits. */
inline bool tryLock (LockHandle handle, bool exclusive)
{
    OVERLAPPED overlapped {};
    const DWORD flags = LOCKFILE_FAIL_IMMEDIATELY | (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0);
    return LockFileEx (handle, flags, 0, 1, 0, &overlapped) != 0;
}

inline void closeLockFile (LockHandle handle)
{
    if (handle != INVALID_HANDLE_VALUE)
        CloseHandle (handle);    // releases every lock taken through it
}
#else
using LockHandle = int;
inline LockHandle invalidLockHandle() { return -1; }

inline LockHandle openLockFile (const juce::File& file)
{
    file.getParentDirectory().createDirectory();
    return ::open (file.getFullPathName().toRawUTF8(), O_RDWR | O_CREAT | O_CLOEXEC, 0644);
}

inline bool tryLock (LockHandle fd, bool exclusive)
{
    return ::flock (fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB) == 0;
}

inline void closeLockFile (LockHandle fd)
{
    if (fd >= 0)
        ::close (fd);            // releases the flock
}
#endif
} // namespace detail

/** Held by a plugin instance for its life: a shared lock on the data root's
    lock file. Taking it never blocks for long — the only thing that can refuse
    a shared lock is the standalone's probe, which holds the exclusive one for
    microseconds, so a refusal is retried a few times and then given up on. An
    instance holding nothing is one the probe cannot see; the retries make that
    a theoretical case. */
struct DataRootLease
{
    explicit DataRootLease (const juce::File& dataRoot)
        : handle (detail::openLockFile (dataRootLockFile (dataRoot)))
    {
        if (handle == detail::invalidLockHandle())
            return;

        for (int attempt = 0; attempt < 20 && ! held; ++attempt)
        {
            if (attempt > 0)
                juce::Thread::sleep (5);

            held = detail::tryLock (handle, false);
        }

        if (! held)
            juce::Logger::writeToLog ("DataRootLease: could not take the shared lock");
    }

    ~DataRootLease()
    {
        detail::closeLockFile (handle);
    }

    bool isHeld() const noexcept { return held; }

private:
    detail::LockHandle handle;
    bool held = false;

    JUCE_DECLARE_NON_COPYABLE (DataRootLease)
};

/** True when any lease on this data root is held — a Plectrify in a DAW, or
    several, or (degenerately) one hosted inside this very process, which holds
    the root in memory just the same. Takes and at once releases the exclusive
    lock otherwise. A lock file that cannot be opened at all reads as "in use"
    too: the data root's own filesystem is what would have to be broken for
    that, and refusing a reset there is the safe answer. */
inline bool dataRootInUseElsewhere (const juce::File& dataRoot)
{
    const auto handle = detail::openLockFile (dataRootLockFile (dataRoot));
    if (handle == detail::invalidLockHandle())
        return true;

    const bool free = detail::tryLock (handle, true);
    detail::closeLockFile (handle);
    return ! free;
}

} // namespace plectrify

#pragma once

#include <JuceHeader.h>

#if ! JUCE_WINDOWS
 #include <cerrno>
 #include <fcntl.h>
 #include <string>
 #include <sys/resource.h>
 #include <sys/wait.h>
 #include <unistd.h>
 #include <vector>
#endif

/**
    Starting a process that outlives this one — the reset's relaunch of the
    app (MainComponent::handleResetApp) and the Linux update notice's hand-off
    to the desktop's updater (SystemUpdateChannel) — and saying honestly
    whether it started.

    Not juce::File::startAsProcess on the POSIX systems, for two reasons. On
    macOS it opens a bundle through NSWorkspace with no completion handler and
    returns true unconditionally, so a launch LaunchServices refused (a
    translocated or quarantined bundle, a dismissed Gatekeeper prompt) would
    quit this app into nothing with the reset still armed and the page's
    "relaunch" error never shown. On Linux it forks a shell without closing
    anything, so the new process inherits every descriptor this one — and
    every plugin it hosts — has open without CLOEXEC, and keeps them for its
    own lifetime: an audio device this instance holds stays held by an updater
    window left open after Plectrify has quit, and a target of the reset about
    to be performed may be a file the relaunch now holds open itself.

    So: fork twice, close every descriptor past the standard three, start a
    session of its own (a terminal's hang-up must not take it down with this
    process), and exec the executable by path — ours, in the reset's case, so
    that is also a direct launch of the binary on macOS rather than a
    LaunchServices request. Twice, because a child this process never waits
    for is a zombie until it exits: the reset's relaunch got away with one
    fork because its parent quits at once, but an updater opened from a
    Plectrify that runs on all evening would sit in `ps` as `<defunct>` per
    click. The middle process exits the moment it has forked, is reaped here,
    and the grandchild — the process that matters — belongs to init. A pipe
    with CLOEXEC set is the classic honest signal: the exec closes it and the
    parent reads end-of-file; a failed fork or exec writes errno through it
    first. Everything between fork and exec is async-signal-safe.

    On Windows it is ShellExecute through startAsProcess, which reports
    failure itself; an argument with a space in it is quoted, since the
    arguments travel as one command line there.
*/
namespace plectrify
{

/** Starts `exe` with `arguments` (argv[1..]) as a process that outlives this
    one. Returns true only once the new process is running. */
#if JUCE_WINDOWS
inline bool startDetached (const juce::File& exe, const juce::StringArray& arguments)
{
    juce::StringArray quoted;
    for (const auto& argument : arguments)
        quoted.add (argument.containsAnyOf (" \t") ? argument.quoted() : argument);

    return exe.startAsProcess (quoted.joinIntoString (" "));
}
#else
inline bool startDetached (const juce::File& exe, const juce::StringArray& arguments)
{
    int signal[2];
    if (::pipe (signal) != 0)
        return false;

    ::fcntl (signal[0], F_SETFD, FD_CLOEXEC);
    ::fcntl (signal[1], F_SETFD, FD_CLOEXEC);

    // Converted before the fork: nothing in the child may allocate.
    const std::string path = exe.getFullPathName().toStdString();
    std::vector<std::string> args;
    for (const auto& argument : arguments)
        args.push_back (argument.toStdString());

    std::vector<char*> argv;
    argv.push_back (const_cast<char*> (path.c_str()));
    for (auto& argument : args)
        argv.push_back (const_cast<char*> (argument.c_str()));
    argv.push_back (nullptr);

    const pid_t pid = ::fork();

    if (pid < 0)
    {
        ::close (signal[0]);
        ::close (signal[1]);
        return false;
    }

    if (pid == 0)
    {
        // The middle process: fork the real one and leave, so the parent has
        // something to reap now and the grandchild answers to init.
        const pid_t grandchild = ::fork();

        if (grandchild < 0)
        {
            const int error = errno;
            const auto written = ::write (signal[1], &error, sizeof (error));
            juce::ignoreUnused (written);
            ::_exit (127);
        }

        if (grandchild > 0)
            ::_exit (0);

        ::setsid();

        struct rlimit limit {};
        const auto highest = (::getrlimit (RLIMIT_NOFILE, &limit) == 0 && limit.rlim_cur != RLIM_INFINITY)
                                 ? (int) juce::jmin<rlim_t> (limit.rlim_cur, (rlim_t) (1 << 20))
                                 : 65536;
        for (int fd = 3; fd < highest; ++fd)
            if (fd != signal[1])
                ::close (fd);

        ::execv (path.c_str(), argv.data());

        const int error = errno;
        const auto written = ::write (signal[1], &error, sizeof (error));
        juce::ignoreUnused (written);
        ::_exit (127);
    }

    ::close (signal[1]);

    int error = 0;
    ssize_t got;
    do
    {
        got = ::read (signal[0], &error, sizeof (error));
    } while (got < 0 && errno == EINTR);

    ::close (signal[0]);

    // The middle process has exited by now (it does so right after its fork,
    // and the pipe only closes once it has); reap it so it is not a zombie.
    int status = 0;
    while (::waitpid (pid, &status, 0) < 0 && errno == EINTR)
    {
    }

    // End-of-file is the exec having happened; anything read is its errno.
    return got == 0;
}
#endif

} // namespace plectrify

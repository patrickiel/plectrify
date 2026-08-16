#pragma once

#include <JuceHeader.h>

#include "AppPaths.h"

#if JUCE_WINDOWS
 #include <windows.h>
 #include <dbghelp.h>
 #pragma comment (lib, "dbghelp.lib")
#endif

/**
    Last-words diagnostics for a process that dies without a message box.

    An installed build that crashes shows the user nothing: the window closes
    and the only trace is an Event Log record naming a raw offset. This turns
    every such death into two artefacts under %APPDATA%/Plectrify/crashes —
    a minidump the shipped PDB can symbolise (Windows), and a line in
    plectrify.log saying when and at what address it happened — so a field
    report can carry evidence instead of a description.

    Installed once at startup, before anything else can fault. The handler
    runs inside the crashing process, so it does the minimum: open file,
    MiniDumpWriteDump, one log line, and lets the process die. It never tries
    to continue — a heap that just faulted is not a heap to keep running on.

    Message-thread only for install; the handler itself runs on whichever
    thread crashed.
*/
namespace plectrify
{
    inline juce::File crashDumpDirectory()
    {
        return appDataDir().getChildFile ("crashes");
    }

#if JUCE_WINDOWS
    namespace detail
    {
        inline LONG WINAPI writeCrashDump (EXCEPTION_POINTERS* info)
        {
            // Everything here is best-effort: a second fault inside the
            // handler must still end in EXCEPTION_CONTINUE_SEARCH so WER (and
            // any armed LocalDumps policy) still sees the original crash.
            const auto dir = crashDumpDirectory();
            dir.createDirectory();

            const auto stamp = juce::Time::getCurrentTime().formatted ("%Y%m%d-%H%M%S");
            const auto dumpFile = dir.getChildFile ("Plectrify-" + stamp + ".dmp");

            const auto handle = CreateFileW (dumpFile.getFullPathName().toWideCharPointer(),
                                             GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                             FILE_ATTRIBUTE_NORMAL, nullptr);
            if (handle != INVALID_HANDLE_VALUE)
            {
                MINIDUMP_EXCEPTION_INFORMATION exceptionInfo {};
                exceptionInfo.ThreadId = GetCurrentThreadId();
                exceptionInfo.ExceptionPointers = info;
                exceptionInfo.ClientPointers = FALSE;

                // WithIndirectlyReferencedMemory keeps the heap pages the
                // crashing stack points at, which is what makes a corrupt
                // object inspectable, at a few tens of MB instead of a full
                // process image.
                MiniDumpWriteDump (GetCurrentProcess(), GetCurrentProcessId(), handle,
                                   static_cast<MINIDUMP_TYPE> (MiniDumpWithIndirectlyReferencedMemory
                                                               | MiniDumpWithThreadInfo
                                                               | MiniDumpWithUnloadedModules),
                                   info != nullptr ? &exceptionInfo : nullptr,
                                   nullptr, nullptr);
                CloseHandle (handle);
            }

            if (info != nullptr && info->ExceptionRecord != nullptr)
            {
                juce::Logger::writeToLog ("CRASH: exception 0x"
                    + juce::String::toHexString ((juce::int64) info->ExceptionRecord->ExceptionCode)
                    + " at 0x"
                    + juce::String::toHexString ((juce::pointer_sized_int) info->ExceptionRecord->ExceptionAddress)
                    + " — dump: " + dumpFile.getFullPathName());
            }

            return EXCEPTION_CONTINUE_SEARCH;
        }
    }
#endif

    inline void installCrashHandler()
    {
       #if JUCE_WINDOWS
        SetUnhandledExceptionFilter (detail::writeCrashDump);
       #else
        // No minidump machinery on macOS — the OS writes a .ips crash report
        // itself. A log line still marks that we went down abnormally.
        juce::SystemStats::setApplicationCrashHandler ([] (void*)
        {
            juce::Logger::writeToLog ("CRASH: fatal signal — see the macOS crash report");
        });
       #endif
    }
}

#pragma once

#include <JuceHeader.h>

#if JUCE_WINDOWS
 #include <windows.h>
 #include <psapi.h>
#elif JUCE_MAC
 #include <mach/mach.h>
#endif

namespace plectrify
{
    /** Current process resident-set size in MB, or 0 where unsupported. */
    inline double getProcessMemoryMb()
    {
       #if JUCE_WINDOWS
        PROCESS_MEMORY_COUNTERS_EX info {};
        info.cb = sizeof (info);
        if (GetProcessMemoryInfo (GetCurrentProcess(),
                                  reinterpret_cast<PROCESS_MEMORY_COUNTERS*> (&info), sizeof (info)))
            return static_cast<double> (info.WorkingSetSize) / (1024.0 * 1024.0);
       #elif JUCE_MAC
        mach_task_basic_info info {};
        mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
        if (task_info (mach_task_self(), MACH_TASK_BASIC_INFO,
                       reinterpret_cast<task_info_t> (&info), &count) == KERN_SUCCESS)
            return static_cast<double> (info.resident_size) / (1024.0 * 1024.0);
       #endif
        return 0.0;
    }
}

#include "BuildInfo.h"

#include "PlectrifyBuildInfo.h"  // generated; see cmake/WriteBuildInfo.cmake

namespace plectrify
{
    static juce::String compilerDescription()
    {
       #if defined (_MSC_FULL_VER)
        // 194435211 -> "MSVC 19.44": major/minor is what identifies the toolset
        // a report was built with; the build/patch digits add noise.
        const auto full = juce::String (_MSC_FULL_VER);
        return "MSVC " + full.substring (0, 2) + "." + full.substring (2, 4);
       #elif defined (__clang_version__)
        return "Clang " + juce::String (__clang_version__).upToFirstOccurrenceOf (" ", false, false);
       #elif defined (__GNUC__)
        return "GCC " + juce::String (__GNUC__) + "." + juce::String (__GNUC_MINOR__);
       #else
        return {};
       #endif
    }

    const BuildInfo& buildInfo()
    {
        static const BuildInfo info
        {
            PLECTRIFY_GIT_COMMIT,
            PLECTRIFY_GIT_DIRTY != 0,
            PLECTRIFY_BUILD_TIME,
            compilerDescription()
        };
        return info;
    }
}

#pragma once

#include <JuceHeader.h>

namespace plectrify
{
    /** Which build this exe actually is — the first thing a bug report needs and
        the one thing it cannot infer from the version number, since any number
        of builds share a version. Filled from a header regenerated on every
        build (see cmake/WriteBuildInfo.cmake); empty strings where the tree was
        built without git. */
    struct BuildInfo
    {
        juce::String commit;    ///< short hash, empty when git was unavailable
        bool dirty = false;     ///< uncommitted tracked changes at build time
        juce::String builtAt;   ///< "YYYY-MM-DD HH:MM UTC"
        juce::String compiler;  ///< e.g. "MSVC 19.44"
    };

    /** Declared here and defined in BuildInfo.cpp on purpose: that keeps the
        generated header — which changes with every commit — out of every other
        translation unit's dependency graph. */
    const BuildInfo& buildInfo();
}

#pragma once

#include <JuceHeader.h>
#include "MetronomeProcessor.h"

#include <cstdint>

/**
    Small helpers shared by the engine and its hosts (the standalone shell and
    the VST3 plugin): bridge payload shapes and the metronome pattern's compact
    wire/persist encoding. Header-inline so both sides compile one definition.
*/
namespace plectrify
{
    /** A StringArray as a JSON array, for the handful of list-valued fields the
        bridge carries. Always an array, even for one element: a field whose
        wire type depended on how many values it happened to hold would make the
        page's normalizer guess. */
    inline juce::var toVarArray (const juce::StringArray& strings)
    {
        juce::Array<juce::var> out;
        for (const auto& s : strings)
            out.add (s);

        return out;
    }

    /** One digit per beat ("2010…") back into the packed accent pattern. The
        same string appears in audio_settings.xml and in the status payload, so
        the codec is shared rather than duplicated per caller. */
    inline std::uint64_t decodeMetronomePattern (const juce::String& text)
    {
        auto pattern = MetronomeProcessor::defaultPattern();
        const int count = juce::jmin (text.length(), MetronomeProcessor::maxBeatsPerBar);
        for (int beat = 0; beat < count; ++beat)
        {
            const int level = (int) text[beat] - (int) '0';
            if (juce::isPositiveAndBelow (level, 4))
                pattern = MetronomeProcessor::packLevel (
                    pattern, beat, (MetronomeProcessor::BeatLevel) level);
        }
        return pattern;
    }

    inline juce::String encodeMetronomePattern (std::uint64_t pattern, int beats)
    {
        juce::String text;
        for (int beat = 0; beat < beats; ++beat)
            text += juce::String ((int) MetronomeProcessor::levelAt (pattern, beat));
        return text;
    }
}

#pragma once

#include <JuceHeader.h>

/**
    Where TONE3000 downloads live on disk, and what they are called.

    Everything lands under the machine-wide content root beside the catalogue's
    own installs — %PROGRAMDATA%/Plectrify/tone3000 on Windows,
    /Users/Shared/Plectrify/tone3000 on macOS:

        tone3000/
          nam/<toneId>-<modelId>.nam     neural captures
          ir/<toneId>-<modelId>.wav      cabinet impulse responses
          images/<toneId>.jpg            cover art, for an offline drawer
          .staging/                      partial downloads, never read

    THE FILENAME IS PART OF THE FORMAT. A Neural Amp Modeler patch stores the
    absolute path of its capture inside the plugin's opaque state, so the name
    a download gets is what every patch made from it will name forever. Hence
    ids and nothing else: a tone retitled upstream, or a creator renamed, must
    not move the file out from under patches already saved. Human-readable
    names live in the patch's provenance, where they can be refreshed for free.

    It also follows that this directory is deliberately **not** a package
    `installDir`. Nothing in packaging/ may pick these files up: they are the
    user's own downloads under TONE3000's terms, never Plectrify's to
    redistribute.

    The layout rules here are pure functions so the ones that matter for
    safety — that a URL cannot name a file outside the root, and that only two
    extensions are ever written — are covered offline.
*/
namespace Tone3000Library
{
/** The formats Plectrify can actually play: a NAM capture, or an impulse response
    NAM's own IR slot loads. Anything else in the catalogue is filtered out of
    the browse view rather than downloaded and left unusable. */
enum class Format
{
    nam,
    ir,
};

/** The format a TONE3000 `format` string names, or nullopt for one Plectrify
    has no plugin for (aida-x, proteus, aa-snapshot). */
std::optional<Format> formatFromString (const juce::String& format);

juce::String toString (Format);

/** The subdirectory and extension a format uses. */
juce::String directoryFor (Format);
juce::String extensionFor (Format);

/** Where a model belongs, relative to the tone3000 root:
    "nam/<toneId>-<modelId>.nam". Deterministic, so re-downloading a tone on
    another machine restores exactly the path a patch's plugin state already
    names — which is what makes a TONE3000 patch repairable rather than lost.

    Returns an empty string for ids that are not plain positive integers: these
    become a filesystem path, so nothing that could contain a separator or a
    traversal is allowed anywhere near it. */
juce::String modelRelativePath (juce::int64 toneId, juce::int64 modelId, Format);

/** Cover art for a tone: "images/<toneId>.jpg". Same id rule. */
juce::String imageRelativePath (juce::int64 toneId);

/** Is this a relative path this module could have produced? The guard for
    anything arriving from the network or from a patch document — a `file`
    field is read back from a patch we did not necessarily write. */
bool isSafeRelativePath (const juce::String& relativePath);

/** Does the storage URL's own filename end in an extension we accept for this
    format? TONE3000 hands back a signed storage URL, and its extension is the
    only claim about the payload we get before downloading it — so it is
    checked against an allowlist rather than trusted, and never used to *pick*
    the destination, which the format already decided. */
bool urlMatchesFormat (const juce::String& modelUrl, Format);

/** Of everything under the root, which files no patch names any more. The
    referenced set comes from the UI, which holds every patch's `file`; this
    only reports, and deleting is always a user action. */
juce::StringArray unreferencedFiles (const juce::StringArray& present,
                                     const juce::StringArray& referenced);

/** The tone3000 root under a given content root, plus the subdirectories a
    download needs. Separated from the pure rules above so tests need no disk. */
juce::File rootDirectory (const juce::File& contentRoot);

//==============================================================================
/** One candidate model of a tone, reduced to what choosing between them needs. */
struct ModelChoice
{
    juce::int64 id = 0;
    /** TONE3000's `architecture_version`: "1", "2" or "custom". */
    juce::String architecture;
    /** TONE3000's size class: "standard", "lite", "feather", "nano", "xl". */
    juce::String size;
};

/** Which model of a tone to download, as an index into `models`, or -1 when
    there is nothing to pick.

    Plectrify picks rather than asks. A tone usually carries one model, and where
    it carries several they are the same capture at different weights — a choice
    between "sounds right" and "sounds right and costs less CPU", which is not a
    question worth interrupting someone with a guitar in their hands. The rule:

      - the architecture asked for wins outright, since a model of the other
        generation may not load into this Neural Amp Modeler at all;
      - then size, preferring `standard` — the weight NAM's own defaults assume.
        `xl` ranks last despite being the most faithful: this is a live rig, and
        the model runs in the audio callback;
      - then the lowest id, so the answer is stable rather than dependent on the
        order two merged API pages happened to arrive in.

    Pure, and the reason it is here rather than inline in the service: it is the
    one piece of the no-questions-asked flow a user can disagree with, so it is
    worth being able to state exactly what it does. */
int chooseModel (const juce::Array<ModelChoice>& models, const juce::String& preferredArchitecture);
} // namespace Tone3000Library

#pragma once

#include <JuceHeader.h>

#include <optional>

/**
    Reads and rewrites the two file paths inside a captured Neural Amp Modeler
    plugin state, so Plectrify can point a live NAM module at a capture it just
    downloaded without asking the user to find the file in NAM's own browser.

    This is what makes the whole TONE3000 integration possible. NAM does not
    serialise the model — it serialises the model's *absolute path* and reloads
    from it. `NeuralAmpModeler::SerializeState` writes, as consecutive iPlug2
    `IByteChunk::PutStr` fields (a native-endian int32 `strlen` — no terminator
    is counted and none is written — followed by exactly that many bytes):

        1. "###NeuralAmpModeler###"   the format marker
        2. the plugin version string
        3. mNAMPath                   the .nam capture
        4. mIRPath                    the cabinet impulse response
        …then SerializeParams.

    `UnserializeState` reads them back and, via `_UnserializeApplyConfig`,
    calls `_StageModel`/`_StageIR` for whichever is non-empty. So "load this
    tone into this module" is: capture the module's state, rewrite fields 3 and
    4, apply it back. The user's own input gain, EQ and noise gate survive the
    swap, because everything else in the blob is left untouched.

    It also means a TONE3000 patch can be *repaired* on another machine, or
    another operating system, by rewriting the paths to wherever that machine
    keeps its downloads — something a shipped patch pack, whose state we cannot
    edit, can never do.

    Everything here is a pure function over strings; no filesystem, no threads,
    no plugin instance. That is what lets it be unit-tested offline against
    captured fixtures (see Tests/tone3000/NamStateCodecTests.cpp).

    THREE ENVELOPES, AND THEY ARE NOT THE SAME BASE64. What
    `MainComponent::handleCaptureModuleState` hands the UI is:

      standard base64 (juce::Base64)
        └─ AudioProcessor::copyXmlToBinary's binary envelope:
           [LE uint32 magic 0x21324356][LE uint32 totalSize - 9][XML][NUL]
             └─ <VST3PluginState> with one child element per VST3 interface
                (IComponent, and usually IEditController as well)
                  └─ juce::MemoryBlock::toBase64Encoding — NOT standard base64:
                     "<decimal byte count>.<chars over '.A-Za-z0-9+'>"
                       └─ the iPlug2 chunk containing the marker above

    Both length prefixes have to be recomputed when a path changes size, and
    the inner layer must go through juce::MemoryBlock rather than juce::Base64
    or the result is silent garbage. JUCE applies IEditController *after*
    IComponent, so a rewrite that touches only the first element can be quietly
    undone by the second: every element carrying the marker is rewritten.

    NAM's chunk layout is iPlug2's `SerializeState`, not a published contract,
    so a future NAM may move it. `rewrite` therefore validates before it edits
    and returns `unsupportedLayout` rather than producing a blob that would
    corrupt a plugin's state — see the release procedure note in AGENTS.md.
*/
namespace NamStateCodec
{
/** The two paths a Neural Amp Modeler state carries. Either may be empty,
    which is how NAM says "nothing loaded in that slot". */
struct Paths
{
    juce::String namPath;
    juce::String irPath;
};

/** What the two path fields say, or nullopt when this blob carries no
    recognisable Neural Amp Modeler chunk (a different plugin, or a NAM whose
    layout this build does not understand). */
std::optional<Paths> read (const juce::String& base64State);

enum class Result
{
    ok,
    /** No `###NeuralAmpModeler###` marker anywhere — not a NAM state. */
    notNamState,
    /** The JUCE/VST3 wrapper did not decode: bad base64, wrong magic, a length
        field that disagrees with the payload, unparseable XML. */
    malformedEnvelope,
    /** The marker is there but the fields after it are not the four strings
        this codec knows how to edit. Nothing is written. */
    unsupportedLayout,
};

/** Rewrite the path fields and hand back a blob the plugin will accept.

    A `nullopt` field is left exactly as it is, so "load an IR and keep the
    capture" is one call rather than a read-modify-write dance. An empty string
    is a real value meaning "clear this slot".

    `outBase64State` is only written on `ok`.
*/
Result rewrite (const juce::String& base64State,
                std::optional<juce::String> namPath,
                std::optional<juce::String> irPath,
                juce::String& outBase64State);

/** The marker that identifies the chunk, exposed for tests and diagnostics. */
extern const char* const namChunkMarker;
} // namespace NamStateCodec

#include <JuceHeader.h>

#include "NamStateCodec.h"

#include <iostream>

// Offline coverage for the one piece of the TONE3000 integration that edits an
// opaque plugin state: the codec that repoints Neural Amp Modeler at a capture
// Plectrify just downloaded. Everything here is synthesised rather than captured,
// so it runs with no plugin installed; the fixtures a real NAM produces are
// exercised separately (see Tests/tone3000/fixtures).
//
// The synthesiser below is deliberately written against the *format*, not
// against the codec — it lays out iPlug2 PutStr fields and JUCE's two nested
// encodings by hand, so a change that broke either would fail here rather than
// agreeing with itself.

namespace
{
int failures = 0;

void check (bool condition, const juce::String& what)
{
    if (! condition)
    {
        ++failures;
        std::cerr << "FAIL " << what << "\n";
    }
}

/** One iPlug2 PutStr field: a native-endian int32 strlen, then the bytes.
    No terminator is counted and none is written. */
void putStr (juce::MemoryOutputStream& out, const juce::String& text)
{
    const auto* utf8 = text.toRawUTF8();
    const auto length = (int) std::strlen (utf8);
    out.writeInt (length);
    out.write (utf8, (size_t) length);
}

/** Does `block` contain `text` verbatim? A plugin chunk is binary and full of
    NULs, so this is a byte search rather than anything that goes through a
    string type. */
bool containsBytes (const juce::MemoryBlock& block, const juce::String& text)
{
    const auto* needle = text.toRawUTF8();
    const auto needleLength = std::strlen (needle);
    const auto* data = (const juce::uint8*) block.getData();

    if (block.getSize() < needleLength)
        return false;

    for (size_t i = 0; i + needleLength <= block.getSize(); ++i)
        if (std::memcmp (data + i, needle, needleLength) == 0)
            return true;

    return false;
}

/** A stand-in for what NeuralAmpModeler::SerializeState produces: the marker,
    the version, the two paths, then whatever SerializeParams left behind —
    represented here by a recognisable tail we can assert survives untouched. */
juce::MemoryBlock namChunk (const juce::String& namPath,
                            const juce::String& irPath,
                            const juce::String& version = "0.7.15")
{
    juce::MemoryBlock block;
    juce::MemoryOutputStream out (block, false);

    // iPlug2's VST3 wrapper puts a preamble in front of the chunk, so the codec
    // must find the marker rather than assume it is at offset zero.
    out.writeInt (0x1234);
    putStr (out, NamStateCodec::namChunkMarker);
    putStr (out, version);
    putStr (out, namPath);
    putStr (out, irPath);

    // The parameter tail. Bytes below 0x20 on purpose: real parameter data is
    // binary, and the codec must copy it through rather than treat it as text.
    const juce::uint8 params[] = { 0x00, 0x01, 0x02, 0x03, 0x7f, 0xff, 0x10, 0x00 };
    out.write (params, sizeof (params));
    out.flush();

    return block;
}

/** Wrap one or more interface blobs the way juce::VST3PluginInstance does:
    each in a child element as MemoryBlock::toBase64Encoding, the tree through
    copyXmlToBinary, the whole thing in standard base64. */
juce::String wrapState (const juce::Array<juce::MemoryBlock>& blocks,
                        const juce::StringArray& names)
{
    juce::XmlElement head ("VST3PluginState");

    for (int i = 0; i < blocks.size(); ++i)
        head.createNewChildElement (names[i])->addTextElement (blocks[i].toBase64Encoding());

    juce::MemoryBlock binary;
    juce::AudioProcessor::copyXmlToBinary (head, binary);
    return juce::Base64::toBase64 (binary.getData(), binary.getSize());
}

juce::String oneElementState (const juce::String& namPath, const juce::String& irPath)
{
    return wrapState ({ namChunk (namPath, irPath) }, { "IComponent" });
}

/** How JUCE really captures a VST3: IComponent *and* IEditController, applied
    in that order. iPlug2 is single-component, so both can carry the chunk. */
juce::String twoElementState (const juce::String& namPath, const juce::String& irPath)
{
    return wrapState ({ namChunk (namPath, irPath), namChunk (namPath, irPath) },
                      { "IComponent", "IEditController" });
}

const juce::String shortPath = "C:\\ProgramData\\Plectrify\\tone3000\\nam\\1-2.nam";
const juce::String longPath =
    "C:\\ProgramData\\Plectrify\\tone3000\\nam\\1234567890-9876543210-a-very-long-name.nam";
const juce::String irPath = "C:\\ProgramData\\Plectrify\\tone3000\\ir\\7-8.wav";

void testRead()
{
    const auto paths = NamStateCodec::read (oneElementState (shortPath, irPath));

    check (paths.has_value(), "a NAM state's paths are readable");
    check (paths.has_value() && paths->namPath == shortPath, "the capture path round-trips");
    check (paths.has_value() && paths->irPath == irPath, "the IR path round-trips");

    const auto empty = NamStateCodec::read (oneElementState ("", ""));
    check (empty.has_value() && empty->namPath.isEmpty() && empty->irPath.isEmpty(),
           "empty paths are a value, not an absence");
}

void testRewriteGrowsAndShrinks()
{
    // The length fields are what a naive equal-length substitution would get
    // away with and a real rewrite must not depend on, so both directions are
    // covered rather than one.
    for (const auto& from : { shortPath, longPath })
    {
        for (const auto& to : { shortPath, longPath })
        {
            juce::String out;
            const auto result = NamStateCodec::rewrite (oneElementState (from, irPath), to, {}, out);

            check (result == NamStateCodec::Result::ok, "rewrite succeeds: " + from + " -> " + to);

            const auto paths = NamStateCodec::read (out);
            check (paths.has_value() && paths->namPath == to, "the new capture path is readable back");
            check (paths.has_value() && paths->irPath == irPath, "an untouched IR path is preserved");
        }
    }
}

void testRewriteLeavesTheParameterTailAlone()
{
    juce::String out;
    NamStateCodec::rewrite (oneElementState (shortPath, irPath), longPath, {}, out);

    juce::MemoryOutputStream raw;
    juce::Base64::convertFromBase64 (raw, out);
    auto xml = juce::AudioProcessor::getXmlFromBinary (raw.getData(), (int) raw.getDataSize());

    juce::MemoryBlock block;
    check (xml != nullptr && xml->getFirstChildElement() != nullptr
               && block.fromBase64Encoding (xml->getFirstChildElement()->getAllSubText().trim()),
           "the rewritten envelope decodes through both layers");

    const juce::uint8 params[] = { 0x00, 0x01, 0x02, 0x03, 0x7f, 0xff, 0x10, 0x00 };
    check (block.getSize() > sizeof (params)
               && std::memcmp ((const juce::uint8*) block.getData() + block.getSize() - sizeof (params),
                               params,
                               sizeof (params))
                      == 0,
           "the parameter tail survives the splice byte for byte");
}

void testBothElementsAreRewritten()
{
    // JUCE applies IEditController last, so a codec that rewrote only the first
    // element would be silently undone by the second. This is the case that
    // passes a lazier unit test and fails in the app.
    juce::String out;
    const auto result = NamStateCodec::rewrite (twoElementState (shortPath, irPath), longPath, {}, out);

    check (result == NamStateCodec::Result::ok, "a two-element state rewrites");

    juce::MemoryOutputStream raw;
    juce::Base64::convertFromBase64 (raw, out);
    auto xml = juce::AudioProcessor::getXmlFromBinary (raw.getData(), (int) raw.getDataSize());

    int checked = 0;

    if (xml != nullptr)
    {
        for (auto* element : xml->getChildIterator())
        {
            juce::MemoryBlock block;

            if (! block.fromBase64Encoding (element->getAllSubText().trim()))
                continue;

            // Searched as bytes, not as a juce::String: the chunk contains NULs
            // (the wrapper preamble, the parameter tail), and fromUTF8 would
            // stop at the first one and make both checks pass vacuously.
            check (containsBytes (block, longPath),
                   "element " + element->getTagName() + " carries the new path");
            check (! containsBytes (block, shortPath),
                   "element " + element->getTagName() + " has no stale path");
            ++checked;
        }
    }

    check (checked == 2, "both interface elements were examined");
}

void testClearingAndTargetingOneSlot()
{
    juce::String out;

    check (NamStateCodec::rewrite (oneElementState (shortPath, irPath), {}, "", out)
               == NamStateCodec::Result::ok,
           "the IR slot can be cleared on its own");

    const auto paths = NamStateCodec::read (out);
    check (paths.has_value() && paths->namPath == shortPath && paths->irPath.isEmpty(),
           "clearing one slot leaves the other exactly as it was");
}

void testRefusals()
{
    juce::String out;

    check (NamStateCodec::rewrite ("not base64 at all !!!", shortPath, {}, out)
               == NamStateCodec::Result::malformedEnvelope,
           "garbage input is refused as a malformed envelope");

    check (NamStateCodec::rewrite (juce::Base64::toBase64 ("hello"), shortPath, {}, out)
               == NamStateCodec::Result::malformedEnvelope,
           "base64 that is not a JUCE binary-XML envelope is refused");

    // A different plugin's state: a well-formed envelope with no NAM chunk.
    juce::MemoryBlock other;
    other.append ("some other plugin's opaque bytes", 31);
    check (NamStateCodec::rewrite (wrapState ({ other }, { "IComponent" }), shortPath, {}, out)
               == NamStateCodec::Result::notNamState,
           "another plugin's state is refused as not-NAM");

    check (NamStateCodec::read (wrapState ({ other }, { "IComponent" })).has_value() == false,
           "reading another plugin's state yields nothing");

    // The marker present but the fields after it not what we expect — the
    // NAM-version-drift case. Nothing may be written.
    {
        juce::MemoryBlock block;
        juce::MemoryOutputStream stream (block, false);
        putStr (stream, NamStateCodec::namChunkMarker);
        stream.writeInt (999999); // a version length that cannot be right
        stream.writeInt (0);
        stream.flush();

        const auto before = out;
        check (NamStateCodec::rewrite (wrapState ({ block }, { "IComponent" }), shortPath, {}, out)
                   == NamStateCodec::Result::unsupportedLayout,
               "an unrecognised layout is refused rather than corrupted");
        check (out == before, "a refused rewrite writes nothing to the output");
    }

    // A truncated chunk: the marker's own length field disagrees with what
    // follows, so it must not be mistaken for the start of a field.
    {
        juce::MemoryBlock block;
        block.append (NamStateCodec::namChunkMarker, std::strlen (NamStateCodec::namChunkMarker));
        check (NamStateCodec::rewrite (wrapState ({ block }, { "IComponent" }), shortPath, {}, out)
                   == NamStateCodec::Result::notNamState,
               "the marker without its length prefix is not a NAM chunk");
    }
}

void testMarkerInParameterDataIsNotMistakenForTheChunk()
{
    // The characters could legitimately appear inside parameter data (a preset
    // name, say). Only a preceding length field that agrees makes it a chunk.
    juce::MemoryBlock block;
    juce::MemoryOutputStream stream (block, false);
    stream.writeInt (7); // a length that does not match the marker's 22
    stream.write (NamStateCodec::namChunkMarker, std::strlen (NamStateCodec::namChunkMarker));
    stream.flush();

    juce::String out;
    check (NamStateCodec::rewrite (wrapState ({ block }, { "IComponent" }), shortPath, {}, out)
               == NamStateCodec::Result::notNamState,
           "the marker with a disagreeing length prefix is ignored");
}

/** Whatever real states were captured in Phase 0 land in Tests/tone3000/fixtures
    as base64 text files named <what>.b64. They are our own NAM's states pointing
    at paths that need not exist, so they carry no TONE3000 content and are
    licence-clean to check in. The suite passes with none present — a machine
    without NAM installed still gets the synthetic coverage above. */
void testCapturedFixtures()
{
    const juce::File dir { juce::String (PLECTRIFY_TONE3000_FIXTURE_DIR) };

    if (! dir.isDirectory())
        return;

    int seen = 0;

    for (const auto& file : dir.findChildFiles (juce::File::findFiles, false, "*.b64"))
    {
        const auto state = file.loadFileAsString().trim();
        const auto paths = NamStateCodec::read (state);

        check (paths.has_value(), "fixture " + file.getFileName() + " is recognised as a NAM state");

        if (! paths.has_value())
            continue;

        juce::String out;
        check (NamStateCodec::rewrite (state, longPath, irPath, out) == NamStateCodec::Result::ok,
               "fixture " + file.getFileName() + " rewrites");

        const auto after = NamStateCodec::read (out);
        check (after.has_value() && after->namPath == longPath && after->irPath == irPath,
               "fixture " + file.getFileName() + " reads back the rewritten paths");
        ++seen;
    }

    if (seen > 0)
        std::cout << "NamStateCodec: " << seen << " captured fixture(s) checked\n";
}
} // namespace

int main()
{
    testRead();
    testRewriteGrowsAndShrinks();
    testRewriteLeavesTheParameterTailAlone();
    testBothElementsAreRewritten();
    testClearingAndTargetingOneSlot();
    testRefusals();
    testMarkerInParameterDataIsNotMistakenForTheChunk();
    testCapturedFixtures();

    if (failures != 0)
        return 1;

    std::cout << "NamStateCodec: all cases passed\n";
    return 0;
}

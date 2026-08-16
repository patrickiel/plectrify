#include "NamStateCodec.h"

namespace NamStateCodec
{
const char* const namChunkMarker = "###NeuralAmpModeler###";

namespace
{
/** A path longer than this is not a path, it is a misparse. NAM's own paths
    run to a couple of hundred characters; Windows' extended limit is 32767 but
    nothing NAM writes approaches it, and the point of the bound is to refuse a
    length field we have misread rather than to police the filesystem. */
constexpr int maxFieldBytes = 8192;

/** The version string is short ("0.7.15"). A wildly different length here is
    the clearest signal that the four fields are not where we think they are. */
constexpr int maxVersionBytes = 64;

/** One iPlug2 PutStr field: where its int32 length sits, and where the bytes
    after it end. */
struct Field
{
    int lengthPos = 0;  ///< offset of the int32
    int dataPos = 0;    ///< offset of the first byte of the string
    int length = 0;     ///< number of bytes, excluding any terminator
    int endPos = 0;     ///< one past the last string byte
};

/** Read the PutStr field starting at `pos`, or nullopt if it does not fit
    inside `size` or its length is not plausible. */
std::optional<Field> readField (const juce::uint8* data, int size, int pos, int maxBytes)
{
    if (pos < 0 || pos + 4 > size)
        return {};

    // iPlug2 writes the raw int with memcpy, so this is native byte order.
    // Every platform Plectrify ships on is little-endian.
    const auto length = (int) juce::ByteOrder::littleEndianInt (data + pos);

    if (length < 0 || length > maxBytes || pos + 4 + length > size)
        return {};

    Field f;
    f.lengthPos = pos;
    f.dataPos = pos + 4;
    f.length = length;
    f.endPos = f.dataPos + length;
    return f;
}

juce::String fieldText (const juce::uint8* data, const Field& f)
{
    return juce::String::fromUTF8 ((const char*) (data + f.dataPos), f.length);
}

/** A path field must be plain text. A control byte in there means we are
    reading something that is not a string, and rewriting around it would
    corrupt the chunk. */
bool looksLikeAPath (const juce::uint8* data, const Field& f)
{
    for (int i = 0; i < f.length; ++i)
        if (data[f.dataPos + i] < 0x20)
            return false;

    return true;
}

/** The three fields this codec cares about, located inside one decoded chunk:
    the version (read only, to validate the layout) and the two paths. */
struct Layout
{
    Field version, namPath, irPath;
};

/** Find the NAM chunk in `block` and locate its fields, or nullopt when the
    marker is absent (a different plugin) — `layoutBad` distinguishes "no
    marker" from "marker present but the fields are not what we expect", since
    the two mean very different things to the caller. */
std::optional<Layout> locate (const juce::MemoryBlock& block, bool& layoutBad)
{
    layoutBad = false;

    const auto size = (int) block.getSize();
    const auto* data = (const juce::uint8*) block.getData();
    const auto markerLength = (int) std::strlen (namChunkMarker);

    // The marker is the *content* of the first PutStr field, so its own int32
    // length sits four bytes in front of it and must agree — which is what
    // proves we have found a serialised field rather than the same characters
    // appearing somewhere in the parameter data.
    for (int i = 4; i + markerLength <= size; ++i)
    {
        if (std::memcmp (data + i, namChunkMarker, (size_t) markerLength) != 0)
            continue;

        const auto marker = readField (data, size, i - 4, maxFieldBytes);

        if (! marker.has_value() || marker->length != markerLength)
            continue;

        const auto version = readField (data, size, marker->endPos, maxVersionBytes);

        if (! version.has_value())
        {
            layoutBad = true;
            return {};
        }

        const auto namPath = readField (data, size, version->endPos, maxFieldBytes);

        if (! namPath.has_value() || ! looksLikeAPath (data, *namPath))
        {
            layoutBad = true;
            return {};
        }

        const auto irPath = readField (data, size, namPath->endPos, maxFieldBytes);

        if (! irPath.has_value() || ! looksLikeAPath (data, *irPath))
        {
            layoutBad = true;
            return {};
        }

        return Layout { *version, *namPath, *irPath };
    }

    return {};
}

void appendField (juce::MemoryOutputStream& out, const juce::String& text)
{
    const auto utf8 = text.toRawUTF8();
    const auto length = (int) std::strlen (utf8);
    out.writeInt (length);
    out.write (utf8, (size_t) length);
}

/** Rebuild `block` with the two path fields replaced. Everything outside them
    — the marker, the version, and the whole of SerializeParams after — is
    copied through byte for byte. */
juce::MemoryBlock spliced (const juce::MemoryBlock& block,
                           const Layout& layout,
                           const juce::String& namPath,
                           const juce::String& irPath)
{
    const auto* data = (const juce::uint8*) block.getData();

    juce::MemoryBlock out;
    juce::MemoryOutputStream stream (out, false);

    stream.write (data, (size_t) layout.namPath.lengthPos);
    appendField (stream, namPath);
    appendField (stream, irPath);
    stream.write (data + layout.irPath.endPos, block.getSize() - (size_t) layout.irPath.endPos);
    stream.flush();

    return out;
}

/** The VST3 state as JUCE hands it over: the outer base64 and the binary XML
    envelope both undone, leaving the element tree whose children each hold one
    interface's opaque blob. */
struct Envelope
{
    std::unique_ptr<juce::XmlElement> xml;
};

std::optional<Envelope> decodeEnvelope (const juce::String& base64State)
{
    juce::MemoryOutputStream raw;

    if (! juce::Base64::convertFromBase64 (raw, base64State) || raw.getDataSize() == 0)
        return {};

    // JUCE's own pair, deliberately: the magic number, the length field and the
    // trailing NUL are its format, and reimplementing them here would be a
    // second definition that could drift.
    auto xml = juce::AudioProcessor::getXmlFromBinary (raw.getData(), (int) raw.getDataSize());

    if (xml == nullptr)
        return {};

    return Envelope { std::move (xml) };
}

juce::String encodeEnvelope (const juce::XmlElement& xml)
{
    juce::MemoryBlock binary;
    juce::AudioProcessor::copyXmlToBinary (xml, binary);
    return juce::Base64::toBase64 (binary.getData(), binary.getSize());
}

/** The base64 payload of one interface element. Note this is
    MemoryBlock::toBase64Encoding's "<decimal count>.<chars>" format, not
    juce::Base64 — see the header. */
bool decodeElement (const juce::XmlElement& element, juce::MemoryBlock& out)
{
    const auto text = element.getAllSubText().trim();
    return text.isNotEmpty() && out.fromBase64Encoding (text);
}

void encodeElement (juce::XmlElement& element, const juce::MemoryBlock& block)
{
    element.deleteAllChildElements();
    element.addTextElement (block.toBase64Encoding());
}
} // namespace

std::optional<Paths> read (const juce::String& base64State)
{
    const auto envelope = decodeEnvelope (base64State);

    if (! envelope.has_value())
        return {};

    for (auto* element : envelope->xml->getChildIterator())
    {
        juce::MemoryBlock block;

        if (! decodeElement (*element, block))
            continue;

        bool layoutBad = false;

        if (const auto layout = locate (block, layoutBad))
        {
            const auto* data = (const juce::uint8*) block.getData();
            return Paths { fieldText (data, layout->namPath), fieldText (data, layout->irPath) };
        }
    }

    return {};
}

Result rewrite (const juce::String& base64State,
                std::optional<juce::String> namPath,
                std::optional<juce::String> irPath,
                juce::String& outBase64State)
{
    auto envelope = decodeEnvelope (base64State);

    if (! envelope.has_value())
        return Result::malformedEnvelope;

    // Every element carrying the marker is rewritten, not just the first.
    // JUCE writes IComponent and IEditController and applies them in that
    // order, so leaving a stale path in the second would silently undo the
    // first — a rewrite that "works" in a unit test and does nothing in the app.
    int rewritten = 0;

    for (auto* element : envelope->xml->getChildIterator())
    {
        juce::MemoryBlock block;

        if (! decodeElement (*element, block))
            continue;

        bool layoutBad = false;
        const auto layout = locate (block, layoutBad);

        if (layoutBad)
            return Result::unsupportedLayout;

        if (! layout.has_value())
            continue;

        const auto* data = (const juce::uint8*) block.getData();

        encodeElement (*element,
                       spliced (block,
                                *layout,
                                namPath.value_or (fieldText (data, layout->namPath)),
                                irPath.value_or (fieldText (data, layout->irPath))));
        ++rewritten;
    }

    if (rewritten == 0)
        return Result::notNamState;

    outBase64State = encodeEnvelope (*envelope->xml);
    return Result::ok;
}
} // namespace NamStateCodec

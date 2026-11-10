#include "Tone3000Library.h"

#include <initializer_list>

namespace Tone3000Library
{
namespace
{
/** An id becomes part of a filename, so nothing but digits is tolerated. Zero
    and negatives are refused too: TONE3000 ids are positive, and "0" or "-1"
    reaching here means we are naming a file from something we misread. */
bool isUsableId (juce::int64 id)
{
    return id > 0;
}
} // namespace

std::optional<Format> formatFromString (const juce::String& format)
{
    const auto lower = format.trim().toLowerCase();

    if (lower == "nam")
        return Format::nam;

    if (lower == "ir")
        return Format::ir;

    return {};
}

juce::String toString (Format format)
{
    return format == Format::nam ? "nam" : "ir";
}

juce::String directoryFor (Format format)
{
    return format == Format::nam ? "nam" : "ir";
}

juce::String extensionFor (Format format)
{
    return format == Format::nam ? ".nam" : ".wav";
}

juce::String modelRelativePath (juce::int64 toneId, juce::int64 modelId, Format format)
{
    if (! isUsableId (toneId) || ! isUsableId (modelId))
        return {};

    return directoryFor (format) + "/" + juce::String (toneId) + "-" + juce::String (modelId)
           + extensionFor (format);
}

juce::String imageRelativePath (juce::int64 toneId)
{
    if (! isUsableId (toneId))
        return {};

    return "images/" + juce::String (toneId) + ".jpg";
}

juce::String imageRequestPrefix()
{
    return "tone3000/images/";
}

juce::int64 toneIdFromImageRequest (const juce::String& requestPath)
{
    const auto path = requestPath.upToFirstOccurrenceOf ("?", false, false)
                          .upToFirstOccurrenceOf ("#", false, false)
                          .trimCharactersAtStart ("/");

    if (! path.startsWith (imageRequestPrefix()) || ! path.endsWith (".jpg"))
        return 0;

    const auto digits = path.substring (imageRequestPrefix().length(), path.length() - 4);

    // Digits and nothing else, and few enough to fit: getLargeIntValue would
    // read "12abc" as 12 and "-3" as a number.
    if (digits.isEmpty() || digits.length() > 18 || ! digits.containsOnly ("0123456789"))
        return 0;

    const auto id = digits.getLargeIntValue();
    return isUsableId (id) ? id : 0;
}

juce::String imageMediaType (const void* data, size_t size)
{
    const auto* bytes = static_cast<const unsigned char*> (data);
    const auto startsWith = [bytes, size] (std::initializer_list<unsigned char> magic, size_t offset = 0)
    {
        if (bytes == nullptr || size < offset + magic.size())
            return false;

        size_t i = offset;

        for (const auto expected : magic)
            if (bytes[i++] != expected)
                return false;

        return true;
    };

    if (startsWith ({ 0xFF, 0xD8, 0xFF }))
        return "image/jpeg";

    if (startsWith ({ 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A }))
        return "image/png";

    if (startsWith ({ 'R', 'I', 'F', 'F' }) && startsWith ({ 'W', 'E', 'B', 'P' }, 8))
        return "image/webp";

    if (startsWith ({ 'G', 'I', 'F', '8' }))
        return "image/gif";

    return {};
}

bool isFetchableImageUrl (const juce::String& url)
{
    return url.startsWithIgnoreCase ("https://") && url.length() > 8;
}

bool isSafeRelativePath (const juce::String& relativePath)
{
    if (relativePath.isEmpty())
        return false;

    // Backslashes are refused outright rather than normalised: every path this
    // module produces uses forward slashes, so one arriving with a backslash
    // did not come from here and is not to be repaired into something valid.
    if (relativePath.containsChar ('\\') || relativePath.containsChar (':'))
        return false;

    if (relativePath.startsWithChar ('/') || relativePath.startsWithChar ('.'))
        return false;

    const auto segments = juce::StringArray::fromTokens (relativePath, "/", {});

    if (segments.size() != 2)
        return false;

    for (const auto& segment : segments)
    {
        if (segment.isEmpty() || segment == "." || segment == "..")
            return false;

        for (const auto character : segment)
            if (character < 0x20 || juce::String ("<>:\"|?*").containsChar (character))
                return false;
    }

    const auto& directory = segments[0];

    if (directory != "nam" && directory != "ir" && directory != "images")
        return false;

    return true;
}

bool urlMatchesFormat (const juce::String& modelUrl, Format format)
{
    // Only the URL's path is inspected: a query string is where a signed
    // storage URL keeps its token, and it routinely contains dots and slashes
    // that would otherwise look like a filename.
    const auto path = juce::URL (modelUrl).getSubPath();
    const auto name = path.fromLastOccurrenceOf ("/", false, false).toLowerCase();

    if (! name.contains ("."))
        return false;

    const auto extension = "." + name.fromLastOccurrenceOf (".", false, false);

    if (format == Format::nam)
        return extension == ".nam";

    // TONE3000 publishes impulse responses as WAV, and NAM's IR slot loads
    // WAV. An allowlist rather than "anything that is not .nam": the extension
    // is a claim made by a URL we did not write.
    return extension == ".wav";
}

juce::StringArray unreferencedFiles (const juce::StringArray& present,
                                     const juce::StringArray& referenced)
{
    juce::StringArray unused;

    for (const auto& file : present)
        if (! referenced.contains (file))
            unused.add (file);

    return unused;
}

juce::File rootDirectory (const juce::File& contentRoot)
{
    return contentRoot.getChildFile ("tone3000");
}

//==============================================================================
namespace
{
/** Lower is better. An unrecognised size sorts after every known one but ahead
    of nothing at all — TONE3000 may add a class, and a model we cannot rank is
    still a model we can load. */
int sizeRank (const juce::String& size)
{
    const auto lower = size.trim().toLowerCase();

    if (lower == "standard") return 0;
    if (lower == "lite")     return 1;
    if (lower == "feather")  return 2;
    if (lower == "nano")     return 3;
    if (lower == "xl")       return 4;

    return 5;
}
} // namespace

int chooseModel (const juce::Array<ModelChoice>& models, const juce::String& preferredArchitecture)
{
    int best = -1;

    for (int i = 0; i < models.size(); ++i)
    {
        const auto& candidate = models.getReference (i);

        if (best < 0)
        {
            best = i;
            continue;
        }

        const auto& incumbent = models.getReference (best);

        const auto matches = [&preferredArchitecture] (const ModelChoice& model)
        {
            return preferredArchitecture.isNotEmpty()
                   && model.architecture.trim() == preferredArchitecture.trim();
        };

        if (matches (candidate) != matches (incumbent))
        {
            if (matches (candidate))
                best = i;

            continue;
        }

        if (sizeRank (candidate.size) != sizeRank (incumbent.size))
        {
            if (sizeRank (candidate.size) < sizeRank (incumbent.size))
                best = i;

            continue;
        }

        if (candidate.id < incumbent.id)
            best = i;
    }

    return best;
}
} // namespace Tone3000Library

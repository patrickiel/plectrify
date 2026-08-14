#include "Tone3000SelectUrl.h"

namespace Tone3000SelectUrl
{
namespace
{
const char* const authorizationParam = "authorization_id";

juce::String trimmedBase (const juce::String& apiBase)
{
    return apiBase.trimCharactersAtEnd ("/");
}

juce::String selectRoot (const juce::String& apiBase)
{
    return trimmedBase (apiBase) + "/api/v1/select";
}

juce::String pathOf (const juce::String& url)
{
    return url.upToFirstOccurrenceOf ("?", false, false).trimCharactersAtEnd ("/");
}

juce::String queryOf (const juce::String& url)
{
    return url.fromFirstOccurrenceOf ("?", false, false);
}
} // namespace

bool isSelectPage (const juce::String& url, const juce::String& apiBase)
{
    if (url.isEmpty() || apiBase.isEmpty())
        return false;

    const auto path = pathOf (url);
    const auto root = selectRoot (apiBase);

    // The root itself, or something beneath it. Matched with the separator
    // rather than as a bare prefix, so a future "/api/v1/selection" is not
    // mistaken for a page of this flow.
    return path == root || path.startsWith (root + "/");
}

juce::String placeOf (const juce::String& url, const juce::String& apiBase)
{
    if (! isSelectPage (url, apiBase))
        return {};

    // Path relative to the host, so a place stays valid if the API base ever
    // moves — and so what is stored reads as a page rather than as a link.
    auto place = pathOf (url).fromFirstOccurrenceOf (trimmedBase (apiBase), false, false);

    juce::StringArray kept;

    for (const auto& parameter : juce::StringArray::fromTokens (queryOf (url), "&", {}))
        if (parameter.isNotEmpty()
            && ! parameter.upToFirstOccurrenceOf ("=", false, false).equalsIgnoreCase (authorizationParam))
            kept.add (parameter);

    if (! kept.isEmpty())
        place << "?" << kept.joinIntoString ("&");

    return place;
}

juce::String authorizationIdOf (const juce::String& url)
{
    for (const auto& parameter : juce::StringArray::fromTokens (queryOf (url), "&", {}))
        if (parameter.upToFirstOccurrenceOf ("=", false, false).equalsIgnoreCase (authorizationParam))
            return parameter.fromFirstOccurrenceOf ("=", false, false);

    return {};
}

juce::String urlForPlace (const juce::String& apiBase,
                          const juce::String& place,
                          const juce::String& authorizationId)
{
    if (place.isEmpty() || authorizationId.isEmpty())
        return {};

    const auto url = trimmedBase (apiBase) + place;

    // Refuses to rebuild anything that is not a page of this flow, so a place
    // read back from disk cannot send the window somewhere else carrying a live
    // authorization.
    if (! isSelectPage (url, apiBase))
        return {};

    return url + (url.containsChar ('?') ? "&" : "?") + authorizationParam + "="
           + authorizationId;
}
} // namespace Tone3000SelectUrl

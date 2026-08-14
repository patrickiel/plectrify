#include "Tone3000Auth.h"

namespace Tone3000Auth
{
namespace
{
juce::String randomBase64Url (int numBytes)
{
    juce::MemoryBlock bytes ((size_t) numBytes);
    auto& random = juce::Random::getSystemRandom();

    for (int i = 0; i < numBytes; ++i)
        ((juce::uint8*) bytes.getData())[i] = (juce::uint8) random.nextInt (256);

    return base64Url (bytes.getData(), bytes.getSize());
}

/** One `key=value` pair, escaped for a query string. */
void addParam (juce::String& query, const juce::String& key, const juce::String& value)
{
    query << (query.isEmpty() ? "?" : "&")
          << juce::URL::addEscapeChars (key, true)
          << "="
          << juce::URL::addEscapeChars (value, true);
}
} // namespace

juce::String base64Url (const void* data, size_t numBytes)
{
    return juce::Base64::toBase64 (data, numBytes)
        .replaceCharacter ('+', '-')
        .replaceCharacter ('/', '_')
        .removeCharacters ("=");
}

juce::String sha256Base64Url (const juce::String& text)
{
    const auto utf8 = text.toRawUTF8();
    const juce::SHA256 hash (utf8, std::strlen (utf8));
    const auto raw = hash.getRawData();
    return base64Url (raw.getData(), raw.getSize());
}

Pkce createPkce()
{
    Pkce pkce;
    pkce.codeVerifier = randomBase64Url (32);
    pkce.codeChallenge = sha256Base64Url (pkce.codeVerifier);
    pkce.state = randomBase64Url (16);
    return pkce;
}

juce::String buildAuthorizeUrl (const juce::String& apiBase,
                                const juce::String& clientId,
                                const juce::String& redirectUri,
                                const AuthorizeOptions& options,
                                const Pkce& pkce)
{
    juce::String query;
    addParam (query, "client_id", clientId);
    addParam (query, "redirect_uri", redirectUri);
    addParam (query, "response_type", "code");
    addParam (query, "code_challenge", pkce.codeChallenge);
    addParam (query, "code_challenge_method", "S256");
    addParam (query, "state", pkce.state);

    if (options.prompt.isNotEmpty())
        addParam (query, "prompt", options.prompt);

    if (options.toneId.isNotEmpty())
        addParam (query, "tone_id", options.toneId);

    if (options.format.isNotEmpty())
        addParam (query, "format", options.format);

    // Underscore-joined, which is TONE3000's convention for every list
    // parameter except `creators` — usernames may contain an underscore, so
    // that one is comma-joined. See Tone3000Client's query builder.
    if (! options.gears.isEmpty())
        addParam (query, "gears", options.gears.joinIntoString ("_"));

    if (options.architecture.isNotEmpty())
        addParam (query, "architecture", options.architecture);

    if (options.loginHint.isNotEmpty())
        addParam (query, "login_hint", options.loginHint);

    if (options.menubar)
        addParam (query, "menubar", "true");

    if (options.preview)
        addParam (query, "preview", "true");

    // Trailing slashes are stripped: the API host redirects a doubled slash,
    // and a redirect is a round trip we can simply not take.
    return apiBase.trimCharactersAtEnd ("/") + "/api/v1/oauth/authorize" + query;
}

Callback parseCallback (const juce::String& url, const juce::String& redirectUri)
{
    Callback callback;

    // Compared without the query, so the match is on the endpoint the URI
    // names rather than on whatever TONE3000 happened to append. A prefix test
    // against the bare string would also accept a lookalike host that merely
    // starts the same way.
    const auto base = url.upToFirstOccurrenceOf ("?", false, false);

    if (base != redirectUri.trimCharactersAtEnd ("/")
        && base != redirectUri.trimCharactersAtEnd ("/") + "/")
        return callback;

    callback.isCallback = true;

    const juce::URL parsed { url };
    const auto& keys = parsed.getParameterNames();
    const auto& values = parsed.getParameterValues();

    for (int i = 0; i < keys.size(); ++i)
    {
        const auto& key = keys[i];
        const auto& value = values[i];

        if (key == "code")           callback.code = value;
        else if (key == "state")     callback.state = value;
        else if (key == "tone_id")   callback.toneId = value;
        else if (key == "model_id")  callback.modelId = value;
        else if (key == "error")     callback.error = value;
        else if (key == "canceled")  callback.canceled = (value == "true");
    }

    return callback;
}

CallbackVerdict verify (const Callback& callback, const juce::String& expectedState)
{
    // First and unconditionally. A callback whose state does not match is not
    // this attempt's, so nothing else it says — not its error, not its
    // cancellation — is ours to act on.
    if (expectedState.isEmpty() || callback.state != expectedState)
        return CallbackVerdict::stateMismatch;

    if (callback.canceled && callback.code.isEmpty())
        return CallbackVerdict::canceled;

    if (callback.error.isNotEmpty())
        return CallbackVerdict::denied;

    if (callback.code.isEmpty())
        return CallbackVerdict::missingCode;

    return CallbackVerdict::ok;
}

juce::String authorizationCodeBody (const juce::String& code,
                                    const juce::String& codeVerifier,
                                    const juce::String& redirectUri,
                                    const juce::String& clientId)
{
    juce::String body;
    addParam (body, "grant_type", "authorization_code");
    addParam (body, "code", code);
    addParam (body, "code_verifier", codeVerifier);
    addParam (body, "redirect_uri", redirectUri);
    addParam (body, "client_id", clientId);
    return body.substring (1); // a form body carries no leading '?'
}

juce::String refreshTokenBody (const juce::String& refreshToken, const juce::String& clientId)
{
    juce::String body;
    addParam (body, "grant_type", "refresh_token");
    addParam (body, "refresh_token", refreshToken);
    addParam (body, "client_id", clientId);
    return body.substring (1);
}

Credentials credentialsFromTokenResponse (const juce::var& json,
                                          juce::int64 nowMs,
                                          const Credentials& previous)
{
    Credentials out = previous;

    if (const auto access = json.getProperty ("access_token", {}).toString(); access.isNotEmpty())
        out.accessToken = access;

    // A refresh response may legitimately omit the refresh token, meaning
    // "keep using the one you have". Overwriting it with an empty string would
    // sign the user out at the next expiry for no reason.
    if (const auto refresh = json.getProperty ("refresh_token", {}).toString(); refresh.isNotEmpty())
        out.refreshToken = refresh;

    const auto expiresIn = (juce::int64) (int) json.getProperty ("expires_in", 3600);
    out.expiresAt = nowMs + expiresIn * 1000;

    return out;
}

juce::var toVar (const Credentials& c)
{
    auto* object = new juce::DynamicObject();
    object->setProperty ("version", 1);
    object->setProperty ("accessToken", c.accessToken);
    object->setProperty ("refreshToken", c.refreshToken);
    object->setProperty ("expiresAt", c.expiresAt);
    object->setProperty ("userId", c.userId);
    object->setProperty ("username", c.username);
    object->setProperty ("avatarUrl", c.avatarUrl);
    return juce::var { object };
}

Credentials fromVar (const juce::var& v)
{
    Credentials c;
    c.accessToken = v.getProperty ("accessToken", {}).toString();
    c.refreshToken = v.getProperty ("refreshToken", {}).toString();
    c.expiresAt = (juce::int64) v.getProperty ("expiresAt", 0);
    c.userId = v.getProperty ("userId", {}).toString();
    c.username = v.getProperty ("username", {}).toString();
    c.avatarUrl = v.getProperty ("avatarUrl", {}).toString();
    return c;
}
} // namespace Tone3000Auth

#include <JuceHeader.h>

#include "Tone3000Auth.h"

#include <iostream>

// Offline coverage for the rules that decide whether a TONE3000 sign-in is
// legitimate: the PKCE derivation, the authorize URL's parameter set, and the
// callback checks. None of it touches the network, so a broken CSRF or PKCE
// rule fails here rather than in a manual sign-in nobody repeats.

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

const juce::String clientId = "t3k_pub_example";
const juce::String redirectUri = "https://plectrify.com/oauth/tone3000";
const juce::String apiBase = "https://www.tone3000.com";

void testPkce()
{
    // RFC 7636 appendix B's published vector. Worth more than a dozen
    // hand-rolled assertions: it proves the hash, the encoding and the
    // padding strip all agree with the spec rather than merely with each other.
    check (Tone3000Auth::sha256Base64Url ("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
               == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
           "the S256 challenge matches RFC 7636 appendix B");

    const auto pkce = Tone3000Auth::createPkce();

    check (pkce.codeVerifier.length() == 43, "a 32-byte verifier is 43 base64url characters");
    check (pkce.codeChallenge == Tone3000Auth::sha256Base64Url (pkce.codeVerifier),
           "the challenge is derived from the verifier it ships with");
    check (pkce.state.isNotEmpty() && pkce.state != pkce.codeVerifier,
           "the CSRF state is its own value");

    for (const auto& value : { pkce.codeVerifier, pkce.codeChallenge, pkce.state })
        check (! value.containsAnyOf ("+/="),
               "base64url carries none of base64's '+', '/' or padding");

    check (Tone3000Auth::createPkce().codeVerifier != pkce.codeVerifier,
           "every attempt mints a fresh verifier");
}

void testAuthorizeUrl()
{
    Tone3000Auth::Pkce pkce;
    pkce.codeChallenge = "CHALLENGE";
    pkce.state = "STATE";

    Tone3000Auth::AuthorizeOptions options;
    options.prompt = "select_tone";
    options.format = "nam";
    options.gears = { "amp", "amp-cab" };

    const auto url = Tone3000Auth::buildAuthorizeUrl (apiBase, clientId, redirectUri, options, pkce);

    check (url.startsWith ("https://www.tone3000.com/api/v1/oauth/authorize?"), "the endpoint is right");
    check (url.contains ("client_id=t3k_pub_example"), "the publishable key is the client id");
    check (url.contains ("response_type=code"), "the response type is a code");
    check (url.contains ("code_challenge=CHALLENGE"), "the challenge is sent");
    check (url.contains ("code_challenge_method=S256"), "the challenge method is S256");
    check (url.contains ("state=STATE"), "the state is sent");
    check (url.contains ("prompt=select_tone"), "the prompt is sent");
    check (url.contains ("format=nam"), "the format filter is sent");
    check (url.contains ("gears=amp_amp-cab"), "gears are underscore-joined");
    check (url.contains ("redirect_uri=https%3A%2F%2Fplectrify.com%2Foauth%2Ftone3000"),
           "the redirect URI is escaped");

    // A trailing slash on the configured base must not produce a doubled
    // slash, which the API answers with a redirect we would then have to follow.
    check (Tone3000Auth::buildAuthorizeUrl (apiBase + "/", clientId, redirectUri, {}, pkce)
               .startsWith ("https://www.tone3000.com/api/v1/oauth/authorize?"),
           "a trailing slash on the base URL is absorbed");

    const auto plain = Tone3000Auth::buildAuthorizeUrl (apiBase, clientId, redirectUri, {}, pkce);
    check (! plain.contains ("prompt="), "an empty prompt is omitted, not sent blank");
    check (! plain.contains ("gears="), "an empty gear filter is omitted");
    check (! plain.contains ("tone_id="), "an empty tone id is omitted");
}

void testCallbackParsing()
{
    const auto callback = Tone3000Auth::parseCallback (
        redirectUri + "?code=abc&state=STATE&tone_id=42&model_id=7", redirectUri);

    check (callback.isCallback, "the redirect URI is recognised");
    check (callback.code == "abc" && callback.state == "STATE", "code and state are read");
    check (callback.toneId == "42" && callback.modelId == "7", "the selected tone and model are read");

    check (! Tone3000Auth::parseCallback ("https://www.tone3000.com/search?code=abc", redirectUri).isCallback,
           "TONE3000's own pages are not mistaken for the callback");

    // A host that merely starts with ours must not match — the check is on the
    // endpoint, not on a string prefix.
    check (! Tone3000Auth::parseCallback ("https://plectrify.com.evil.example/oauth/tone3000?code=x",
                                          redirectUri)
                .isCallback,
           "a lookalike host is not the callback");

    check (Tone3000Auth::parseCallback (redirectUri + "/?code=abc", redirectUri).isCallback,
           "a trailing slash on the callback still matches");

    const auto canceled = Tone3000Auth::parseCallback (redirectUri + "?canceled=true&state=STATE", redirectUri);
    check (canceled.canceled, "cancellation is read");
}

void testCallbackVerification()
{
    using V = Tone3000Auth::CallbackVerdict;

    Tone3000Auth::Callback good;
    good.isCallback = true;
    good.code = "abc";
    good.state = "STATE";
    check (Tone3000Auth::verify (good, "STATE") == V::ok, "a matching callback with a code is redeemable");

    auto wrongState = good;
    wrongState.state = "SOMETHING ELSE";
    check (Tone3000Auth::verify (wrongState, "STATE") == V::stateMismatch, "a mismatched state is refused");

    check (Tone3000Auth::verify (good, {}) == V::stateMismatch,
           "no attempt in flight means nothing to redeem");

    // The state check comes first on purpose: a callback that is not ours does
    // not get to tell us it was cancelled or denied either.
    auto hostile = good;
    hostile.state = "OTHER";
    hostile.error = "access_denied";
    hostile.canceled = true;
    check (Tone3000Auth::verify (hostile, "STATE") == V::stateMismatch,
           "a mismatched state outranks the error it carries");

    auto canceled = good;
    canceled.code = {};
    canceled.canceled = true;
    check (Tone3000Auth::verify (canceled, "STATE") == V::canceled, "closing the flow reads as cancelled");

    auto denied = good;
    denied.error = "access_denied";
    check (Tone3000Auth::verify (denied, "STATE") == V::denied, "a refusal reads as denied");

    auto empty = good;
    empty.code = {};
    check (Tone3000Auth::verify (empty, "STATE") == V::missingCode, "no code and no reason is its own case");
}

void testTokenBodies()
{
    const auto body = Tone3000Auth::authorizationCodeBody ("the code", "the verifier", redirectUri, clientId);

    check (! body.startsWith ("?"), "a form body carries no leading question mark");
    check (body.contains ("grant_type=authorization_code"), "the grant type is right");
    check (body.contains ("code=the%20code"), "the code is escaped");
    check (body.contains ("code_verifier=the%20verifier"), "the verifier is sent, proving the flow's origin");
    check (body.contains ("client_id=t3k_pub_example"), "the client id is sent");
    check (! body.contains ("client_secret"), "no secret is ever sent from a shipped binary");

    const auto refresh = Tone3000Auth::refreshTokenBody ("rt", clientId);
    check (refresh.contains ("grant_type=refresh_token") && refresh.contains ("refresh_token=rt"),
           "the refresh body is right");
    check (! refresh.contains ("code_verifier"), "a refresh carries no verifier");
}

void testCredentials()
{
    auto* json = new juce::DynamicObject();
    json->setProperty ("access_token", "at");
    json->setProperty ("refresh_token", "rt");
    json->setProperty ("expires_in", 3600);

    const auto credentials = Tone3000Auth::credentialsFromTokenResponse (juce::var { json }, 1'000'000);

    check (credentials.accessToken == "at" && credentials.refreshToken == "rt", "tokens are read");
    check (credentials.expiresAt == 1'000'000 + 3'600'000, "the expiry is absolute, not a duration");
    check (credentials.isValid(), "a pair of tokens is a valid credential");

    check (! credentials.needsRefresh (credentials.expiresAt - 120'000), "no refresh well before expiry");
    check (credentials.needsRefresh (credentials.expiresAt - 30'000),
           "a refresh starts before expiry, not after — a request begun inside the window would 401");

    // A refresh response may omit the refresh token, meaning "keep the one you
    // have". Blanking it would sign the user out at the next expiry.
    auto* refreshed = new juce::DynamicObject();
    refreshed->setProperty ("access_token", "at2");
    refreshed->setProperty ("expires_in", 60);
    const auto next = Tone3000Auth::credentialsFromTokenResponse (juce::var { refreshed }, 2'000'000, credentials);
    check (next.accessToken == "at2" && next.refreshToken == "rt",
           "an omitted refresh token keeps the existing one");

    auto full = credentials;
    full.userId = "u1";
    full.username = "someone";
    full.avatarUrl = "https://example.invalid/a.png";

    const auto round = Tone3000Auth::fromVar (Tone3000Auth::toVar (full));
    check (round.accessToken == full.accessToken && round.refreshToken == full.refreshToken
               && round.expiresAt == full.expiresAt && round.username == full.username
               && round.userId == full.userId && round.avatarUrl == full.avatarUrl,
           "credentials round-trip through their stored form");

    check (! Tone3000Auth::fromVar (juce::var()).isValid(), "an absent file is not a credential");
}
} // namespace

int main()
{
    testPkce();
    testAuthorizeUrl();
    testCallbackParsing();
    testCallbackVerification();
    testTokenBodies();
    testCredentials();

    if (failures != 0)
        return 1;

    std::cout << "Tone3000Auth: all cases passed\n";
    return 0;
}

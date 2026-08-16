#pragma once

#include <JuceHeader.h>

/**
    TONE3000's OAuth 2.0 authorization-code flow with PKCE, as pure functions:
    building the authorize URL, reading the callback the in-app window
    intercepts, forming the token requests, and holding the credentials on
    disk. No network and no windows live here — Tone3000Client makes the
    requests and Tone3000AuthWindow shows the page — so every rule that decides
    whether a sign-in is legitimate is covered by offline tests.

    PKCE, not a client secret. The publishable `t3k_pub_` key is the client id
    and is compiled into the binary, which is what it is for; the `t3k_cs_`
    secret is a server-only credential and must never appear in this repo or in
    a shipped binary. The verifier and the CSRF `state` are minted per attempt
    and held **in memory only** — never written to disk, unlike the browser
    demo's sessionStorage — and cleared on every callback whatever the outcome.

    The access and refresh tokens do go to disk, under the per-user root at
    tone3000/credentials.json. That path is the one thing `resolveAppFile`
    refuses to hand the web page, since the page's sandbox otherwise spans the
    whole of the app data directory and a bearer token has no business being
    readable by a document that also hosts third-party plugin UIs.
*/
namespace Tone3000Auth
{
/** One sign-in attempt's secrets. `codeVerifier` is what proves, at token
    exchange, that whoever redeems the code is whoever asked for it;
    `state` is what proves the callback belongs to this attempt. */
struct Pkce
{
    juce::String codeVerifier;
    juce::String codeChallenge;
    juce::String state;
};

/** base64url with the padding stripped — RFC 7636's encoding, which is not
    juce::Base64's output and emphatically not MemoryBlock::toBase64Encoding. */
juce::String base64Url (const void* data, size_t numBytes);

/** The S256 code challenge for a verifier: base64url(SHA-256(verifier)). */
juce::String sha256Base64Url (const juce::String& text);

/** A fresh verifier (32 random bytes), its challenge, and a fresh state
    (16 random bytes). */
Pkce createPkce();

/** How the authorize page should behave. Empty fields are simply not sent,
    which is how TONE3000 distinguishes "no filter" from a filter. */
struct AuthorizeOptions
{
    /** "select_tone" to browse and pick, "load_tone" for a known tone, empty
        for a plain account connection. */
    juce::String prompt;
    /** Required when prompt is "load_tone". */
    juce::String toneId;
    /** "nam" or "ir" — Plectrify offers no plugin for the other formats, so the
        catalogue is scoped rather than showing tones that cannot be used. */
    juce::String format;
    /** Gear filter; TONE3000 joins these with underscores. */
    juce::StringArray gears;
    /** Neural model architecture: "1", "2" or "custom". Single-valued, and
        **omitting it is not "all"** — TONE3000 then applies its legacy A1 +
        Custom selection and excludes A2, which is what current Neural Amp
        Modeler captures are. Leaving this empty is therefore a decision to
        hide most modern tones, so callers state it. */
    juce::String architecture;
    /** Pre-fills the sign-in field when we already know the account. */
    juce::String loginHint;
    /** Navigation chrome inside the embedded flow. */
    bool menubar = true;
    /** In-flow audition players, so a tone can be heard before it is downloaded. */
    bool preview = true;
};

juce::String buildAuthorizeUrl (const juce::String& apiBase,
                                const juce::String& clientId,
                                const juce::String& redirectUri,
                                const AuthorizeOptions& options,
                                const Pkce& pkce);

/** What came back on the redirect URI. `isCallback` is false for every other
    URL the window navigates to, which is most of them. */
struct Callback
{
    bool isCallback = false;
    juce::String code;
    juce::String state;
    juce::String toneId;
    juce::String modelId;
    juce::String error;
    bool canceled = false;
};

Callback parseCallback (const juce::String& url, const juce::String& redirectUri);

enum class CallbackVerdict
{
    ok,
    /** The callback does not belong to the attempt we started. Treat as
        hostile, not as a retryable error. */
    stateMismatch,
    /** The user closed the flow without signing in. */
    canceled,
    /** TONE3000 said no — a private or deleted tone, or a refused consent. */
    denied,
    /** No code to exchange, and no error explaining why. */
    missingCode,
};

/** Decide whether a callback may be redeemed. The state comparison comes
    first, deliberately: a mismatched callback is not ours to interpret at all,
    so its `error` and `canceled` fields are not to be believed either. */
CallbackVerdict verify (const Callback& callback, const juce::String& expectedState);

/** Form bodies for POST /api/v1/oauth/token. Kept here rather than in the
    client so the exact field set is testable without a socket. */
juce::String authorizationCodeBody (const juce::String& code,
                                    const juce::String& codeVerifier,
                                    const juce::String& redirectUri,
                                    const juce::String& clientId);

juce::String refreshTokenBody (const juce::String& refreshToken, const juce::String& clientId);

/** A connected TONE3000 account. `expiresAt` is milliseconds since the epoch,
    the same clock juce::Time::currentTimeMillis() reports. */
struct Credentials
{
    juce::String accessToken;
    juce::String refreshToken;
    juce::int64 expiresAt = 0;
    juce::String userId;
    juce::String username;
    juce::String avatarUrl;

    bool isValid() const { return accessToken.isNotEmpty() && refreshToken.isNotEmpty(); }

    /** Refresh proactively rather than discovering expiry mid-request: a
        request that starts inside the window would otherwise 401 and have to
        be retried. */
    bool needsRefresh (juce::int64 nowMs) const { return nowMs > expiresAt - 60'000; }
};

/** Read the token endpoint's JSON response. `nowMs` is passed in rather than
    read from the clock so the expiry arithmetic is testable. */
Credentials credentialsFromTokenResponse (const juce::var& json,
                                          juce::int64 nowMs,
                                          const Credentials& previous = {});

juce::var toVar (const Credentials&);
Credentials fromVar (const juce::var&);
} // namespace Tone3000Auth

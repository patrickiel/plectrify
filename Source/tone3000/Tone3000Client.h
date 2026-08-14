#pragma once

#include "Tone3000Auth.h"

#include <JuceHeader.h>

#include <functional>

/**
    Talks to the TONE3000 REST API: authenticated JSON requests with automatic
    token refresh, and model downloads that stream to disk.

    Why this is native rather than fetch() in the web page. Three reasons, and
    each on its own would be enough: the page runs from a local origin, so
    every call would be a cross-origin request at the API's discretion; the
    page's file sandbox is the per-user app data directory, while downloads
    must land in the machine-wide content root; and an OAuth bearer token has
    no business living in a document that also hosts third-party plugin UIs.
    The page therefore never sees a token, a URL or a byte of model data — it
    sees tones, models and progress.

    Threading follows CatalogueInstaller's shape, deliberately: one pool thread,
    so requests run in submission order and never overlap, with every callback
    marshalled back to the message thread. Callers are message-thread objects
    and are spared any locking of their own.
*/
class Tone3000Client
{
public:
    Tone3000Client (juce::String apiBase, juce::String clientId);
    ~Tone3000Client();

    /** One API answer. `ok` means an HTTP success *and* a parsed body; check it
        before touching `json`. `status` is 0 when the request never reached the
        server, which is how "offline" is distinguished from "refused". */
    struct Response
    {
        bool ok = false;
        int status = 0;
        juce::var json;
        juce::String error;
    };

    using ResponseCallback = std::function<void (Response)>;

    // ── Session ──────────────────────────────────────────────────────────────

    void setCredentials (Tone3000Auth::Credentials);
    Tone3000Auth::Credentials getCredentials() const;
    void clearCredentials();
    bool isConnected() const;

    /** Fired whenever the tokens change — after an exchange, and after each
        refresh — so the owner can persist them. Message thread. */
    std::function<void()> onCredentialsChanged;

    /** The refresh token is no longer usable (TONE3000 answers `invalid_grant`).
        The credentials have already been cleared; the owner's job is to tell
        the user they have been signed out. Message thread. */
    std::function<void()> onAuthLost;

    // ── Requests ─────────────────────────────────────────────────────────────

    /** Redeem an authorization code. The only call that works without an
        existing session, and the one that establishes it. */
    void exchangeCode (const juce::String& code,
                       const juce::String& codeVerifier,
                       const juce::String& redirectUri,
                       ResponseCallback);

    /** GET a path under the API base ("/api/v1/tones/42"), with the bearer
        token attached, refreshing first if the current one is close to expiry
        and retrying once on a 401. */
    void getJson (const juce::String& path, ResponseCallback);

    /** PUT or DELETE with no body — favouriting and unfavouriting. */
    void sendJson (const juce::String& verb, const juce::String& path, ResponseCallback);

    struct DownloadProgress
    {
        juce::int64 received = 0;
        /** Zero when the server sent no Content-Length. */
        juce::int64 total = 0;
    };

    /** Fetch a model to `destination`, which must not already exist.

        Written through a sibling `.part` file and moved into place only once
        complete, so an interrupted download is never mistaken for a present
        model — the whole patch-repair story depends on "the file is there"
        meaning "the file is whole".

        `onProgress` fires on the message thread; `onDone` reports an empty
        string on success or a human-readable reason on failure. */
    void downloadModel (const juce::String& modelUrl,
                        const juce::File& destination,
                        std::function<void (DownloadProgress)> onProgress,
                        std::function<void (juce::String)> onDone);

    /** Abandon anything in flight. Safe to call from the message thread at any
        time; a cancelled download leaves no partial file behind. */
    void cancel();

    bool isBusy() const;

private:
    class Job;

    /** Blocks until the pool thread is idle. Everything a job captures is
        owned by this object, so the destructor cannot return while one runs. */
    void stop();

    juce::String resolveAccessToken (juce::String& errorOut);
    Response request (const juce::String& verb,
                      const juce::String& url,
                      const juce::String& body,
                      const juce::StringArray& extraHeaders);

    const juce::String apiBase;
    const juce::String clientId;

    juce::ThreadPool pool { 1 };
    std::atomic<bool> cancelRequested { false };

    /** Guards the credentials alone: the pool thread reads them to sign a
        request and writes them back after a refresh, while the message thread
        may replace or clear them at any moment. */
    mutable juce::CriticalSection credentialsLock;
    Tone3000Auth::Credentials credentials;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Tone3000Client)
};

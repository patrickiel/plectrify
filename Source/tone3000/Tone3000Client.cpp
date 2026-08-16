#include "Tone3000Client.h"

namespace
{
constexpr int connectionTimeoutMs = 10'000;

/** A model that big is not a capture; it is a misread Content-Length or a URL
    pointing somewhere it should not. Refused before a byte is written. */
constexpr juce::int64 maxDownloadBytes = 256LL * 1024 * 1024;

/** Streaming chunk. Small enough that cancelling is responsive, large enough
    that the progress callback does not flood the message thread. */
constexpr int downloadChunkBytes = 64 * 1024;

juce::String trimmedBase (const juce::String& base)
{
    return base.trimCharactersAtEnd ("/");
}
} // namespace

//==============================================================================
Tone3000Client::Tone3000Client (juce::String apiBaseIn, juce::String clientIdIn)
    : apiBase (trimmedBase (apiBaseIn)), clientId (std::move (clientIdIn))
{
}

Tone3000Client::~Tone3000Client()
{
    stop();
}

void Tone3000Client::stop()
{
    cancelRequested = true;
    // Jobs capture `this`, so the destructor must not return while one runs.
    pool.removeAllJobs (true, 5'000);
}

void Tone3000Client::setCredentials (Tone3000Auth::Credentials c)
{
    const juce::ScopedLock lock (credentialsLock);
    credentials = std::move (c);
}

Tone3000Auth::Credentials Tone3000Client::getCredentials() const
{
    const juce::ScopedLock lock (credentialsLock);
    return credentials;
}

void Tone3000Client::clearCredentials()
{
    const juce::ScopedLock lock (credentialsLock);
    credentials = {};
}

bool Tone3000Client::isConnected() const
{
    const juce::ScopedLock lock (credentialsLock);
    return credentials.isValid();
}

bool Tone3000Client::isBusy() const
{
    return pool.getNumJobs() > 0;
}

void Tone3000Client::cancel()
{
    cancelRequested = true;
    pool.removeAllJobs (false, 0);
}

//==============================================================================
Tone3000Client::Response Tone3000Client::request (const juce::String& verb,
                                                  const juce::String& url,
                                                  const juce::String& body,
                                                  const juce::StringArray& extraHeaders)
{
    Response response;

    juce::URL target { url };

    if (body.isNotEmpty())
        target = target.withPOSTData (body);

    int status = 0;
    juce::StringPairArray responseHeaders;

    // Built in one chain: InputStreamOptions is not assignable, so a
    // conditional `options = options.with...()` will not compile.
    auto stream = target.createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs (connectionTimeoutMs)
            .withStatusCode (&status)
            .withResponseHeaders (&responseHeaders)
            .withHttpRequestCmd (verb)
            .withExtraHeaders (extraHeaders.joinIntoString ("\r\n")));

    response.status = status;

    if (stream == nullptr)
    {
        response.error = "Could not reach TONE3000";
        return response;
    }

    const auto text = stream->readEntireStreamAsString();

    if (status < 200 || status >= 300)
    {
        // The API answers errors as JSON too, so the machine-readable reason is
        // preferred over the status line where one is present — `invalid_grant`
        // in particular has to be distinguishable from any other 400.
        const auto parsed = juce::JSON::parse (text);
        const auto code = parsed.getProperty ("error", {}).toString();
        response.json = parsed;
        response.error = code.isNotEmpty() ? code : ("HTTP " + juce::String (status));
        return response;
    }

    response.json = juce::JSON::parse (text);
    response.ok = true;
    return response;
}

/** Returns a usable access token, refreshing first if the current one is close
    to expiring. Runs on the pool thread, which is the only thread that
    refreshes — so there is no single-flight problem to solve: the pool has one
    thread and requests are serialised through it. */
juce::String Tone3000Client::resolveAccessToken (juce::String& errorOut)
{
    auto current = getCredentials();

    if (! current.isValid())
    {
        errorOut = "Not signed in to TONE3000";
        return {};
    }

    if (! current.needsRefresh (juce::Time::currentTimeMillis()))
        return current.accessToken;

    const auto response = request ("POST",
                                   apiBase + "/api/v1/oauth/token",
                                   Tone3000Auth::refreshTokenBody (current.refreshToken, clientId),
                                   { "Content-Type: application/x-www-form-urlencoded" });

    if (! response.ok)
    {
        // A refresh token that is no longer usable is terminal: nothing about
        // the session can be recovered, so it is cleared here rather than left
        // to fail request after request.
        if (response.error == "invalid_grant" || response.status == 400 || response.status == 401)
        {
            clearCredentials();
            juce::MessageManager::callAsync ([this] { if (onAuthLost) onAuthLost(); });
            errorOut = "Your TONE3000 sign-in has expired";
            return {};
        }

        // Anything else — offline, a 500 — leaves the credentials alone and
        // lets the caller retry later.
        errorOut = response.error;
        return {};
    }

    const auto refreshed =
        Tone3000Auth::credentialsFromTokenResponse (response.json, juce::Time::currentTimeMillis(), current);

    setCredentials (refreshed);
    juce::MessageManager::callAsync ([this] { if (onCredentialsChanged) onCredentialsChanged(); });
    return refreshed.accessToken;
}

//==============================================================================
void Tone3000Client::exchangeCode (const juce::String& code,
                                   const juce::String& codeVerifier,
                                   const juce::String& redirectUri,
                                   ResponseCallback callback)
{
    cancelRequested = false;

    pool.addJob (
        [this, code, codeVerifier, redirectUri, callback = std::move (callback)]
        {
            auto response = request ("POST",
                                     apiBase + "/api/v1/oauth/token",
                                     Tone3000Auth::authorizationCodeBody (code, codeVerifier, redirectUri, clientId),
                                     { "Content-Type: application/x-www-form-urlencoded" });

            if (response.ok)
            {
                setCredentials (Tone3000Auth::credentialsFromTokenResponse (response.json,
                                                                            juce::Time::currentTimeMillis()));
                juce::MessageManager::callAsync ([this] { if (onCredentialsChanged) onCredentialsChanged(); });
            }

            juce::MessageManager::callAsync ([callback, response] { callback (response); });
        });
}

void Tone3000Client::getJson (const juce::String& path, ResponseCallback callback)
{
    sendJson ("GET", path, std::move (callback));
}

void Tone3000Client::sendJson (const juce::String& verb, const juce::String& path, ResponseCallback callback)
{
    cancelRequested = false;

    pool.addJob (
        [this, verb, path, callback = std::move (callback)]
        {
            Response response;
            juce::String error;
            auto token = resolveAccessToken (error);

            if (token.isEmpty())
            {
                response.error = error;
                juce::MessageManager::callAsync ([callback, response] { callback (response); });
                return;
            }

            response = request (verb, apiBase + path, {}, { "Authorization: Bearer " + token });

            // One retry on a 401: the token can expire between the check above
            // and the server reading it. Forcing the expiry makes the next
            // resolve refresh rather than hand back the same dead token.
            if (! response.ok && response.status == 401)
            {
                {
                    const juce::ScopedLock lock (credentialsLock);
                    credentials.expiresAt = 0;
                }

                token = resolveAccessToken (error);

                if (token.isNotEmpty())
                    response = request (verb, apiBase + path, {}, { "Authorization: Bearer " + token });
            }

            juce::MessageManager::callAsync ([callback, response] { callback (response); });
        });
}

//==============================================================================
void Tone3000Client::downloadModel (const juce::String& modelUrl,
                                    const juce::File& destination,
                                    std::function<void (DownloadProgress)> onProgress,
                                    std::function<void (juce::String)> onDone)
{
    cancelRequested = false;

    pool.addJob (
        [this, modelUrl, destination, onProgress = std::move (onProgress), onDone = std::move (onDone)]
        {
            const auto finish = [onDone] (juce::String error)
            { juce::MessageManager::callAsync ([onDone, error] { onDone (error); }); };

            juce::String error;
            const auto token = resolveAccessToken (error);

            if (token.isEmpty())
                return finish (error);

            // TONE3000 answers a model URL with a redirect to object storage.
            // Redirects are NOT followed automatically, because JUCE forwards
            // extra headers across them and that would hand our bearer token
            // to a third-party host. The hop is taken by hand instead, with no
            // Authorization header on the second request — the storage URL
            // carries its own signature.
            int status = 0;
            juce::StringPairArray headers;
            auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                               .withConnectionTimeoutMs (connectionTimeoutMs)
                               .withStatusCode (&status)
                               .withResponseHeaders (&headers)
                               .withNumRedirectsToFollow (0)
                               .withExtraHeaders ("Authorization: Bearer " + token);

            auto stream = juce::URL (modelUrl).createInputStream (options);

            if (status >= 300 && status < 400)
            {
                const auto location = headers.getValue ("Location", headers.getValue ("location", {}));

                if (location.isEmpty())
                    return finish ("TONE3000 redirected the download without saying where");

                status = 0;
                stream = juce::URL (location).createInputStream (
                    juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                        .withConnectionTimeoutMs (connectionTimeoutMs)
                        .withStatusCode (&status)
                        .withNumRedirectsToFollow (5));
            }

            if (stream == nullptr || status < 200 || status >= 300)
                return finish (status == 404 ? "This tone is no longer available on TONE3000"
                                             : "The download failed (HTTP " + juce::String (status) + ")");

            const auto total = stream->getTotalLength();

            if (total > maxDownloadBytes)
                return finish ("That download is implausibly large; refusing it");

            // Written to a sibling and moved into place only when whole, so a
            // half-finished file can never be mistaken for a present model —
            // the missing-capture repair path relies on presence meaning
            // completeness.
            const auto partial = destination.getSiblingFile (destination.getFileName() + ".part");
            partial.deleteFile();
            destination.getParentDirectory().createDirectory();

            {
                juce::FileOutputStream out (partial);

                if (out.failedToOpen())
                    return finish ("Could not write to the downloads folder");

                juce::HeapBlock<char> buffer (downloadChunkBytes);
                juce::int64 received = 0;

                for (;;)
                {
                    if (cancelRequested)
                    {
                        out.flush();
                        partial.deleteFile();
                        return finish ("Cancelled");
                    }

                    const auto read = stream->read (buffer, downloadChunkBytes);

                    if (read <= 0)
                        break;

                    if (! out.write (buffer, (size_t) read))
                    {
                        out.flush();
                        partial.deleteFile();
                        return finish ("Ran out of room while downloading");
                    }

                    received += read;

                    if (received > maxDownloadBytes)
                    {
                        out.flush();
                        partial.deleteFile();
                        return finish ("That download is implausibly large; refusing it");
                    }

                    if (onProgress)
                        juce::MessageManager::callAsync (
                            [onProgress, received, total] { onProgress ({ received, total }); });
                }

                out.flush();

                // A truncated transfer that ends cleanly is the failure mode
                // this catches: without the length check it would be moved into
                // place and look like a whole model for ever after.
                if (total > 0 && received != total)
                {
                    partial.deleteFile();
                    return finish ("The download ended early");
                }
            }

            destination.deleteFile();

            if (! partial.moveFileTo (destination))
            {
                partial.deleteFile();
                return finish ("Could not put the download in place");
            }

            finish ({});
        });
}

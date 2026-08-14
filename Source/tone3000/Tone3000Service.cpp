#include "Tone3000Service.h"

#include "AppPaths.h"
#include "CatalogueInstaller.h"
#include "NamStateCodec.h"
#include "Tone3000BrowserWindow.h"

#include <memory>
#include <set>

#if JUCE_MAC
 #include <sys/stat.h>   // ::chmod — the credentials file is tightened to 0600
#endif

#ifndef PLECTRIFY_TONE3000_CLIENT_ID
 #define PLECTRIFY_TONE3000_CLIENT_ID ""
#endif
#ifndef PLECTRIFY_TONE3000_API
 #define PLECTRIFY_TONE3000_API "https://www.tone3000.com"
#endif
#ifndef PLECTRIFY_TONE3000_REDIRECT_URI
 #define PLECTRIFY_TONE3000_REDIRECT_URI "https://plectrify.com/oauth/tone3000"
#endif

namespace
{
const juce::String clientId { PLECTRIFY_TONE3000_CLIENT_ID };
const juce::String apiBase { PLECTRIFY_TONE3000_API };
const juce::String redirectUri { PLECTRIFY_TONE3000_REDIRECT_URI };

/** The plugin whose state we know how to edit. Everything TONE3000 offers in
    the two formats Plectrify supports loads into Neural Amp Modeler — a capture in
    its model slot, an impulse response in its IR slot — so one codec covers
    both and no second plugin is involved. */
const juce::String namPluginName { "NeuralAmpModeler" };

/** Where TONE3000 sends a flow it will not honour any more — a page saying
    "your session has expired, go back to the app and try again".

    It is the *normal* end of a restored page, not an edge case: their sign-in
    session is spent once a tone has been picked through it, so the page saved
    on the way out is guaranteed to redirect here on the way back in. It never
    arrives as a callback, so there is no state mismatch to notice; the only
    signal is this URL. So it is watched for by name, never saved as a place to
    return to, and answered by starting a fresh flow in the same window — which
    is what "go back to the app and try again" means, done for the user. */
const juce::String sessionExpiredPath { "/api/v1/session-expired" };

juce::var property (const juce::var& v, const char* name)
{
    return v.getProperty (name, {});
}

juce::String stringProperty (const juce::var& v, const char* name)
{
    return property (v, name).toString();
}

juce::int64 intProperty (const juce::var& v, const char* name)
{
    return (juce::int64) property (v, name);
}

juce::DynamicObject* object (juce::var& holder)
{
    auto* o = new juce::DynamicObject();
    holder = juce::var { o };
    return o;
}

/** A patch's TONE3000 record, built here rather than on the page because the
    page never sees a tone: it gets this, already flattened, on the finished
    install. The field names are the patch document's (see
    ui/src/lib/engine/tone3000.ts) and the two must agree — this is the only
    place either is written.

    A copy rather than a reference: the drawer has to be readable offline, and a
    tone renamed upstream must not silently rename the user's patch. */
/** One entry of a tone's variant list: what the module's switcher shows, and
    where that capture landed. Names are TONE3000's ("TB Brl 3", "Nrm 2"), which
    is what the creator called the channel and gain setting — nothing here
    invents a label. */
juce::var describeVariant (const juce::var& model, const juce::String& file)
{
    juce::var out;
    auto* o = object (out);
    o->setProperty ("modelId", property (model, "id"));
    o->setProperty ("name", stringProperty (model, "name"));
    o->setProperty ("size", stringProperty (model, "size"));
    o->setProperty ("architecture", stringProperty (model, "architecture_version"));
    o->setProperty ("file", file);
    return out;
}

juce::var describeProvenance (const juce::var& tone, const juce::var& model, const juce::String& file)
{
    juce::var out;
    auto* o = object (out);
    o->setProperty ("toneId", property (tone, "id"));
    o->setProperty ("modelId", property (model, "id"));
    o->setProperty ("title", stringProperty (tone, "title"));
    o->setProperty ("gear", stringProperty (tone, "gear"));
    o->setProperty ("format", stringProperty (tone, "format"));
    o->setProperty ("license", stringProperty (tone, "license"));
    o->setProperty ("url", stringProperty (tone, "url"));
    o->setProperty ("modelName", stringProperty (model, "name"));
    o->setProperty ("size", stringProperty (model, "size"));
    o->setProperty ("architecture", stringProperty (model, "architecture_version"));
    o->setProperty ("file", file);
    o->setProperty ("downloadedAt", juce::Time::getCurrentTime().toISO8601 (true));

    if (const auto* images = property (tone, "images").getArray())
        if (! images->isEmpty())
            o->setProperty ("imageUrl", images->getFirst().toString());

    // Attribution is an obligation under TONE3000's terms, not a nicety, so the
    // creator travels with every patch whether or not anything renders it yet.
    const auto user = property (tone, "user");
    juce::var creator;
    auto* c = object (creator);
    c->setProperty ("id", property (user, "id"));
    c->setProperty ("username", stringProperty (user, "username"));
    c->setProperty ("avatarUrl", stringProperty (user, "avatar_url"));
    c->setProperty ("url", stringProperty (user, "url"));
    o->setProperty ("creator", creator);

    return out;
}
} // namespace

//==============================================================================
Tone3000Service::Tone3000Service (Delegate delegateIn)
    : delegate (std::move (delegateIn)), client (apiBase, clientId)
{
    client.onCredentialsChanged = [this] { saveCredentials(); };
    client.onAuthLost = [this]
    {
        apiAccess = "none";
        saveCredentials();
        pushState();
    };

    loadSession();
}

Tone3000Service::~Tone3000Service()
{
    // Before the client, and before MainComponent tears down the main web view:
    // on Windows this window holds a second WebView2 environment whose COM
    // release is asynchronous.
    browserWindow.reset();
}

//==============================================================================
juce::File Tone3000Service::sessionDirectory() const
{
    // Under the per-user root, never the machine-wide one: a credential must
    // not sit in a directory shared between accounts. This is also the one
    // path MainComponent::resolveAppFile refuses to hand the web page.
    return plectrify::appDataDir().getChildFile ("tone3000");
}

juce::File Tone3000Service::downloadsDirectory() const
{
    return Tone3000Library::rootDirectory (CatalogueInstaller::contentRootDirectory());
}

void Tone3000Service::loadSession()
{
    const auto credentialsFile = sessionDirectory().getChildFile ("credentials.json");

    if (credentialsFile.existsAsFile())
        client.setCredentials (Tone3000Auth::fromVar (juce::JSON::parse (credentialsFile.loadFileAsString())));

    const auto stateFile = sessionDirectory().getChildFile ("state.json");

    if (stateFile.existsAsFile())
    {
        const auto stored = juce::JSON::parse (stateFile.loadFileAsString());
        splashSeen = (bool) property (stored, "splashSeen");
        apiAccess = stringProperty (stored, "apiAccess");
        windowBounds = Tone3000WindowState::fromVar (property (stored, "window"));
        windowPlace = stringProperty (stored, "place");
        windowScroll = (int) property (stored, "scroll");
    }

    // An earlier build saved the browse page here together with the PKCE it
    // belonged to. That could never work — see `windowBounds` — and a code
    // verifier is not something to leave lying about once it has no use, so the
    // file is removed rather than merely ignored.
    sessionDirectory().getChildFile ("flow.json").deleteFile();

    if (apiAccess.isEmpty())
        apiAccess = "none";

    if (client.isConnected() && apiAccess == "none")
        apiAccess = "prompt";
}

void Tone3000Service::saveCredentials()
{
    const auto directory = sessionDirectory();
    directory.createDirectory();

    const auto file = directory.getChildFile ("credentials.json");
    const auto current = client.getCredentials();

    if (! current.isValid())
    {
        file.deleteFile();
        return;
    }

    file.replaceWithText (juce::JSON::toString (Tone3000Auth::toVar (current)));

   #if JUCE_MAC
    // Windows' %APPDATA% is already per-user ACL'd; a mac home directory is
    // world-readable by default, and a bearer token should not be.
    ::chmod (file.getFullPathName().toRawUTF8(), 0600);
   #endif
}

void Tone3000Service::saveLocalState()
{
    const auto directory = sessionDirectory();
    directory.createDirectory();

    auto* stored = new juce::DynamicObject();
    stored->setProperty ("splashSeen", splashSeen);
    stored->setProperty ("apiAccess", apiAccess);
    stored->setProperty ("window", Tone3000WindowState::toVar (windowBounds));
    stored->setProperty ("place", windowPlace);
    stored->setProperty ("scroll", windowScroll);
    directory.getChildFile ("state.json")
        .replaceWithText (juce::JSON::toString (juce::var { stored }));
}

//==============================================================================
juce::var Tone3000Service::describeDownloads() const
{
    juce::Array<juce::var> downloads;
    const auto root = downloadsDirectory();

    if (! root.isDirectory())
        return downloads;

    for (const auto& file : root.findChildFiles (juce::File::findFiles, true, "*.nam;*.wav"))
    {
        const auto relative = file.getRelativePathFrom (root).replaceCharacter ('\\', '/');

        if (! Tone3000Library::isSafeRelativePath (relative))
            continue;

        // "<toneId>-<modelId>" — the name is the record, so the folder needs no
        // index and cannot drift out of step with what is actually on disk.
        const auto ids = file.getFileNameWithoutExtension();

        auto* entry = new juce::DynamicObject();
        entry->setProperty ("toneId", ids.upToFirstOccurrenceOf ("-", false, false).getLargeIntValue());
        entry->setProperty ("modelId", ids.fromLastOccurrenceOf ("-", false, false).getLargeIntValue());
        entry->setProperty ("file", relative);
        entry->setProperty ("bytes", file.getSize());
        downloads.add (juce::var { entry });
    }

    return downloads;
}

void Tone3000Service::pushState()
{
    const auto credentials = client.getCredentials();

    juce::var state;
    auto* o = object (state);
    o->setProperty ("connected", credentials.isValid());
    o->setProperty ("pending", windowOpen);
    o->setProperty ("apiAccess", apiAccess);
    o->setProperty ("splashSeen", splashSeen);
    o->setProperty ("downloads", describeDownloads());

    if (credentials.isValid())
    {
        juce::var user;
        auto* u = object (user);
        u->setProperty ("id", credentials.userId);
        u->setProperty ("username", credentials.username);
        u->setProperty ("avatarUrl", credentials.avatarUrl);
        o->setProperty ("user", user);
    }

    delegate.emit ("tone3000State", state);
}

void Tone3000Service::markSplashSeen()
{
    splashSeen = true;
    saveLocalState();
    pushState();
}

//==============================================================================
juce::String Tone3000Service::authorizeUrl() const
{
    Tone3000Auth::AuthorizeOptions options;
    // Always the Select flow: browsing *is* signing in now, and a user who is
    // already connected lands straight on the catalogue rather than on a
    // consent screen they have seen before.
    options.prompt = "select_tone";
    options.architecture = browseArchitecture;
    return Tone3000Auth::buildAuthorizeUrl (apiBase, clientId, redirectUri, options, pending);
}

void Tone3000Service::connect (const juce::var& payload)
{
    // Where a picked tone should land. Read on every open, including one that
    // only brings an existing window to the front: the user may have started
    // from a different module this time.
    browseModuleId = stringProperty (payload, "moduleId");
    browsePluginId = stringProperty (payload, "pluginId");

    if (const auto architecture = stringProperty (payload, "architecture"); architecture.isNotEmpty())
        browseArchitecture = architecture;

    pendingToneId = {};
    pendingModelId = {};

    // Already there — the window is hidden, not gone. Nothing to rebuild: the
    // page, the search that was typed and the scroll position are all still
    // exactly as they were left.
    if (browserWindow != nullptr && ! flowSpent)
    {
        Tone3000WindowState::trace ("connect: showing the window again, page intact");
        windowOpen = true;
        // The authorize URL as the blank-page fallback: a hidden window that
        // came back with nothing in it is worth starting over rather than
        // handing the user an empty frame.
        browserWindow->show (authorizeUrl());
        pushState();
        return;
    }

    // A fresh attempt: either the first of the session, or the last one was
    // spent on a tone the user picked. The place and the offset are what put
    // them back where they were.
    pending = Tone3000Auth::createPkce();
    placeRestored = false;
    flowSpent = false;
    autoRestarts = 0;
    windowOpen = true;
    Tone3000WindowState::trace ("connect: fresh flow, bounds "
                                + windowBounds.toRectangle().toString() + " place=" + windowPlace
                                + " scroll=" + juce::String (windowScroll));
    pushState();

    if (browserWindow != nullptr)
    {
        // A window whose flow has been spent gets replaced rather than
        // re-navigated. Pointing the old one at a fresh authorize URL looked
        // like the tidier answer — same WebView2, warm profile — and TONE3000
        // answered it with a bare "Error code: 9" page every time. Whatever
        // that is, it only happens to a view that has already carried a
        // completed flow; a new window is the same journey the very first open
        // makes, which works.
        //
        // Destroyed synchronously, which is safe here and nowhere else: this is
        // an ordinary bridge call, not one of the window's own callbacks, so
        // nothing is left executing inside the object being deleted. It also
        // has to be gone before its replacement exists — two WebView2s must not
        // hold the same user-data folder open at once.
        Tone3000WindowState::trace ("flow spent — replacing the window");
        windowBounds = browserWindow->getPlacement();
        saveLocalState();
        browserWindow.reset();
    }

    Tone3000BrowserWindow::Callbacks callbacks;
    callbacks.onCallback = [this] (juce::String url) { handleCallback (url); };

    callbacks.onPlaceChanged = [this] (juce::String url, Tone3000WindowState::Bounds bounds)
    {
        windowBounds = bounds;

        // TONE3000 will not honour this attempt any more — usually because the
        // flow sat unused too long. Recoverable without telling anyone: a fresh
        // attempt lands on the same catalogue.
        if (isSessionExpiredPage (url))
        {
            saveLocalState();
            restartFlow();
            return;
        }

        const auto place = Tone3000SelectUrl::placeOf (url, apiBase);
        restorePlaceAndScroll (url, place);

        // Only their own Select pages are remembered. A tone's outbound link,
        // or the redirect URI on its way through, is not somewhere to reopen.
        if (place.isNotEmpty() && place == windowPlace)
            return; // Nothing new to write; the restore above may still be running.

        if (place.isNotEmpty())
        {
            windowPlace = place;
            // A new page starts at the top. Keeping the old page's offset would
            // scroll the user into the middle of something they never opened.
            windowScroll = 0;
        }

        saveLocalState();
        Tone3000WindowState::trace ("saved " + bounds.toRectangle().toString()
                                    + (bounds.maximised ? " (max)" : "") + "  place=" + windowPlace);
    };

    callbacks.onScrolled = [this] (int scrollY)
    {
        // Ignored while a restore is in flight: the page it is restoring into
        // reports the top until it gets there, and believing that would erase
        // the offset being restored.
        if (scrollToRestore > 0 || scrollY == windowScroll)
            return;

        windowScroll = scrollY;
        saveLocalState();
    };

    callbacks.onClosed = [this]
    {
        // Put away, not thrown away — reopening is then instant and keeps the
        // page exactly as it was. Nothing is in flight any more, so the UI must
        // stop waiting either way.
        hideBrowserWindow();
        pushState();
    };

    browserWindow = std::make_unique<Tone3000BrowserWindow> (authorizeUrl(),
                                                            redirectUri,
                                                            windowBounds,
                                                            std::move (callbacks));
}

bool Tone3000Service::isSessionExpiredPage (const juce::String& url) const
{
    // Compared on the path, with the query dropped, and against the API base
    // rather than as a bare "contains" — the same rule the callback matcher
    // follows, and for the same reason.
    return url.upToFirstOccurrenceOf ("?", false, false).trimCharactersAtEnd ("/")
           == apiBase.trimCharactersAtEnd ("/") + sessionExpiredPath;
}

void Tone3000Service::restorePlaceAndScroll (const juce::String& url, const juce::String& place)
{
    if (place.isEmpty() || browserWindow == nullptr)
        return;

    // The page being restored has arrived: put the reader back down it. Their
    // grids load lazily, so the window keeps asking until the page is long
    // enough — see Tone3000BrowserWindow::restoreScroll.
    if (scrollToRestore > 0 && place == windowPlace)
    {
        Tone3000WindowState::trace ("restoring scroll " + juce::String (scrollToRestore));
        browserWindow->restoreScroll (std::exchange (scrollToRestore, 0));
        return;
    }

    // The flow has landed and handed out an authorization. If the user was
    // somewhere else last time, this is the moment to put them back: the saved
    // place carries no authorization of its own, so it is re-attached to this
    // one. Once per opening — the restore is itself a navigation, and acting on
    // its arrival would loop.
    if (std::exchange (placeRestored, true) || windowPlace.isEmpty() || windowPlace == place)
    {
        // Already on the saved page, so only the offset is left to put back.
        if (windowPlace == place && windowScroll > 0)
        {
            Tone3000WindowState::trace ("restoring scroll " + juce::String (windowScroll));
            browserWindow->restoreScroll (windowScroll);
        }

        return;
    }

    const auto target = Tone3000SelectUrl::urlForPlace (
        apiBase, windowPlace, Tone3000SelectUrl::authorizationIdOf (url));

    if (target.isEmpty())
        return;

    Tone3000WindowState::trace ("restoring place " + windowPlace);
    scrollToRestore = windowScroll;
    browserWindow->goTo (target);
}

void Tone3000Service::hideBrowserWindow()
{
    windowOpen = false;

    if (browserWindow == nullptr)
        return;

    // Read while the window still exists and is placed — this is the last
    // moment either is true of the session, if the app is quit next.
    windowBounds = browserWindow->getPlacement();
    saveLocalState();
    Tone3000WindowState::trace ("hidden, keeping the page: "
                                + windowBounds.toRectangle().toString() + " place=" + windowPlace
                                + " scroll=" + juce::String (windowScroll));

    browserWindow->setVisible (false);
}

void Tone3000Service::closeBrowserWindow()
{
    windowOpen = false;

    if (browserWindow == nullptr)
        return;

    // Captured before the window goes, and from the window rather than from
    // anything tracked earlier: this is the last moment its real placement can
    // be read at all. Reached only when the window is genuinely finished with —
    // signing out — since an ordinary close only hides it.
    windowBounds = browserWindow->getPlacement();
    saveLocalState();
    Tone3000WindowState::trace ("destroyed, saved " + windowBounds.toRectangle().toString()
                                + (windowBounds.maximised ? " (max)" : ""));

    // Deleted asynchronously: this is reached from the window's own callbacks,
    // and deleting a component from inside its own event is how a use-after-free
    // starts.
    if (auto* window = browserWindow.release())
        juce::MessageManager::callAsync ([window] { delete window; });
}

void Tone3000Service::restartFlow()
{
    // Bounded, because this now fires from a page load: if TONE3000 were to
    // expire a *fresh* flow immediately, restarting on every expiry would spin
    // the window forever. One automatic retry per opening, then the page is
    // left alone saying what it says — which at least tells the user something
    // true, unlike a window that reloads under them.
    if (autoRestarts >= 1)
        return;

    ++autoRestarts;
    Tone3000WindowState::trace ("session expired — restarting the flow in place");

    // A page TONE3000 no longer honours: a fresh attempt starts in the same
    // window, rather than leaving the user on an error about a flow they never
    // knew they were in.
    pending = Tone3000Auth::createPkce();
    windowOpen = true;
    pushState();

    if (browserWindow != nullptr)
        browserWindow->goTo (authorizeUrl());
}

void Tone3000Service::handleCallback (const juce::String& url)
{
    const auto callback = Tone3000Auth::parseCallback (url, redirectUri);
    const auto verdict = Tone3000Auth::verify (callback, pending.state);
    const auto verifier = pending.codeVerifier;

    // Cleared whatever the outcome, so a code can never be replayed and a
    // second callback cannot ride the first attempt's state.
    pending = {};

    // The authorization in this window has just been spent, so the page behind
    // it can no longer serve a pick. Kept anyway — hidden, and re-authorised on
    // the next showing, which is cheaper and less jarring than destroying a
    // WebView2 and building another one.
    flowSpent = true;
    hideBrowserWindow();

    if (verdict != Tone3000Auth::CallbackVerdict::ok)
    {
        if (verdict != Tone3000Auth::CallbackVerdict::canceled)
        {
            juce::var failure;
            auto* o = object (failure);
            o->setProperty ("ok", false);
            o->setProperty ("error",
                            verdict == Tone3000Auth::CallbackVerdict::stateMismatch
                                ? "That sign-in did not match the one Plectrify started"
                                : "TONE3000 declined the sign-in");
            delegate.emit ("tone3000Connected", failure);
        }

        pushState();
        return;
    }

    pendingToneId = callback.toneId;
    pendingModelId = callback.modelId;

    client.exchangeCode (callback.code, verifier, redirectUri,
                         [this] (Tone3000Client::Response response)
                         {
                             if (! response.ok)
                             {
                                 juce::var failure;
                                 auto* o = object (failure);
                                 o->setProperty ("ok", false);
                                 o->setProperty ("error", response.error);
                                 delegate.emit ("tone3000Connected", failure);
                                 pushState();
                                 return;
                             }

                             fetchUserThenProbeAccess();
                         });
}

void Tone3000Service::fetchUserThenProbeAccess()
{
    client.getJson ("/api/v1/user",
                    [this] (Tone3000Client::Response response)
                    {
                        if (response.ok)
                        {
                            auto credentials = client.getCredentials();
                            credentials.userId = property (response.json, "id").toString();
                            credentials.username = stringProperty (response.json, "username");
                            credentials.avatarUrl = stringProperty (response.json, "avatar_url");
                            client.setCredentials (credentials);
                            saveCredentials();
                        }

                        probeApiAccess();
                    });
}

void Tone3000Service::probeApiAccess()
{
    // Deliberately not a probe any more, and not a network call at all.
    //
    // This used to ask `/tones/search?page_size=1` to find out whether the key
    // could search. But TONE3000's free tier permits only the OAuth prompt
    // flows and the bounded list endpoints, and `/tones/search` is outside it —
    // so the probe was itself the thing it was checking permission for, made on
    // every single sign-in. Being *able* to reach an endpoint is not permission
    // to use it.
    //
    // Plectrify ships non-commercial, so the answer is known at build time and is
    // stated rather than discovered. If a commercial agreement is ever signed,
    // flip TONE3000_COMMERCIAL_AGREEMENT in ui/src/lib/engine/tone3000.ts and
    // widen this to "full"; the panel already branches on it.
    apiAccess = "prompt";
    saveLocalState();
    pushState();

    juce::var done;
    auto* o = object (done);
    o->setProperty ("ok", true);
    o->setProperty ("toneId", pendingToneId);
    delegate.emit ("tone3000Connected", done);

    // A sign-in with no tone attached is just a sign-in: the user opened the
    // window and closed the flow without picking anything.
    if (const auto toneId = pendingToneId.getLargeIntValue(); toneId > 0)
        beginInstall (toneId, pendingModelId.getLargeIntValue());

    pendingToneId = {};
    pendingModelId = {};
}

void Tone3000Service::disconnect()
{
    client.clearCredentials();
    apiAccess = "none";
    // The page goes with the account — it is a page inside that account's
    // browsing, and the next person to sign in here has no business resuming
    // it. The window goes too, rather than being hidden: it is showing that
    // account's catalogue, and its profile holds that account's session cookie.
    windowPlace = {};
    windowScroll = 0;
    flowSpent = false;
    closeBrowserWindow();
    saveCredentials();
    saveLocalState();
    pushState();
}

//==============================================================================
void Tone3000Service::beginInstall (juce::int64 toneId, juce::int64 modelId)
{
    if (run.active)
        return;

    run = {};
    run.runId = juce::Uuid().toDashedString();
    run.toneId = toneId;
    run.modelId = modelId;
    run.moduleId = browseModuleId;
    // The page's answer if it had one, the host's otherwise. Neural Amp Modeler
    // ships inside the installation, so "not installed" is no longer a state
    // the flow has to be built around — but a scan that has not finished is.
    run.pluginId = browsePluginId.isNotEmpty() || ! delegate.findNamPluginId
                       ? browsePluginId
                       : delegate.findNamPluginId();
    run.active = true;

    {
        juce::var out;
        auto* o = object (out);
        o->setProperty ("runId", run.runId);
        o->setProperty ("stage", "queued");
        delegate.emit ("tone3000InstallProgress", out);
    }

    client.getJson (
        "/api/v1/tones/" + juce::String (toneId),
        [this, toneId, modelId] (Tone3000Client::Response toneResponse)
        {
            if (! toneResponse.ok)
                return failInstall (toneResponse.status == 404 || toneResponse.status == 403
                                        ? "That tone is no longer available on TONE3000"
                                        : toneResponse.error);

            const auto tone = std::make_shared<juce::var> (toneResponse.json);

            // TWO REQUESTS, NOT ONE. `GET /models` with no `architecture` uses
            // TONE3000's legacy selection — A1 plus Custom — and silently
            // *excludes* A2, which is what current Neural Amp Modeler captures
            // are. A pack published as A2 would come back with no models at all
            // and the download would fail on a tone that is perfectly fine.
            const auto models = std::make_shared<juce::Array<juce::var>>();
            const auto seen = std::make_shared<std::set<juce::int64>>();

            const auto collect = [models, seen] (const Tone3000Client::Response& response)
            {
                if (const auto* data = property (response.json, "data").getArray())
                    for (const auto& model : *data)
                        // Merged by id: the two selections may legitimately
                        // overlap, and a duplicate would skew the choice below.
                        if (seen->insert ((juce::int64) property (model, "id")).second)
                            models->add (model);
            };

            const auto pick = [this, tone, models, modelId]
            {
                run.models = *models;

                if (models->isEmpty())
                    return failInstall ("TONE3000 has no model for that tone that Plectrify can load");

                // The Select flow may already have named one — the user's own
                // choice on TONE3000's page, which is never second-guessed.
                if (modelId > 0)
                    for (const auto& model : *models)
                        if ((juce::int64) property (model, "id") == modelId)
                            return startDownload (*tone, model);

                juce::Array<Tone3000Library::ModelChoice> choices;

                for (const auto& model : *models)
                    choices.add ({ (juce::int64) property (model, "id"),
                                   stringProperty (model, "architecture_version"),
                                   stringProperty (model, "size") });

                const auto index = Tone3000Library::chooseModel (choices, browseArchitecture);

                if (index < 0)
                    return failInstall ("TONE3000 has no model for that tone that Plectrify can load");

                startDownload (*tone, (*models)[index]);
            };

            const auto base = "/api/v1/models?tone_id=" + juce::String (toneId) + "&page_size=300";

            client.getJson (base,
                            [this, base, collect, pick] (Tone3000Client::Response legacy)
                            {
                                collect (legacy);
                                client.getJson (base + "&architecture=2",
                                                [collect, pick] (Tone3000Client::Response a2)
                                                {
                                                    collect (a2);
                                                    pick();
                                                });
                            });
        });
}

void Tone3000Service::failInstall (const juce::String& error)
{
    juce::var out;
    auto* o = object (out);
    o->setProperty ("runId", run.runId);
    o->setProperty ("ok", false);
    o->setProperty ("error", error);
    delegate.emit ("tone3000InstallFinished", out);
    run = {};
    pushState();
}

void Tone3000Service::startDownload (const juce::var& tone, const juce::var& model)
{
    run.modelId = (juce::int64) property (model, "id");

    const auto format = Tone3000Library::formatFromString (stringProperty (tone, "format"));

    if (! format.has_value())
        return failInstall ("Plectrify cannot play that tone's format");

    run.format = *format;

    const auto relative = Tone3000Library::modelRelativePath (run.toneId, run.modelId, run.format);

    if (relative.isEmpty())
        return failInstall ("That tone is missing an identifier");

    const auto modelUrl = stringProperty (model, "model_url");

    if (! Tone3000Library::urlMatchesFormat (modelUrl, run.format))
        return failInstall ("That download does not look like a " + Tone3000Library::toString (run.format)
                            + " file");

    run.destination = downloadsDirectory().getChildFile (relative);
    run.provenance = describeProvenance (tone, model, relative);

    // The whole variant set travels with the patch, so the module's switcher
    // needs no network and no second lookup — see `downloadRemainingModels`
    // for the files themselves.
    juce::Array<juce::var> described;

    for (const auto& candidate : run.models)
    {
        const auto candidateFile = Tone3000Library::modelRelativePath (
            run.toneId, (juce::int64) property (candidate, "id"), run.format);

        if (candidateFile.isNotEmpty())
            described.add (describeVariant (candidate, candidateFile));
    }

    if (auto* o = run.provenance.getDynamicObject())
        o->setProperty ("models", described);

    const auto namPath = run.format == Tone3000Library::Format::nam ? run.destination.getFullPathName()
                                                                    : juce::String();
    const auto irPath = run.format == Tone3000Library::Format::ir ? run.destination.getFullPathName()
                                                                  : juce::String();

    const auto progress = [this] (Tone3000Client::DownloadProgress p)
    {
        juce::var out;
        auto* o = object (out);
        o->setProperty ("runId", run.runId);
        o->setProperty ("stage", "downloading");
        o->setProperty ("received", p.received);
        o->setProperty ("total", p.total);
        o->setProperty ("title", stringProperty (run.provenance, "title"));
        delegate.emit ("tone3000InstallProgress", out);
    };

    // Already downloaded: the filename is derived from the ids alone, so a
    // second patch from the same model costs no network at all.
    if (run.destination.existsAsFile() && run.destination.getSize() > 0)
        return buildPatchState (run, namPath, irPath);

    // The shared semantics have to be established, not inherited: on macOS a
    // stock-umask directory here would be owned by whichever account downloaded
    // first, and no second account could add a tone beside it.
    CatalogueInstaller::createSharedContentDirectory (run.destination.getParentDirectory());

    {
        juce::var out;
        auto* o = object (out);
        o->setProperty ("runId", run.runId);
        o->setProperty ("stage", "downloading");
        o->setProperty ("title", stringProperty (run.provenance, "title"));
        delegate.emit ("tone3000InstallProgress", out);
    }

    client.downloadModel (modelUrl, run.destination, progress,
                          [this, namPath, irPath] (juce::String error)
                          {
                              if (error.isNotEmpty())
                                  return failInstall (error);

                              buildPatchState (run, namPath, irPath);
                          });
}

void Tone3000Service::buildPatchState (const InstallRun& current, juce::String namPath, juce::String irPath)
{
    {
        juce::var out;
        auto* o = object (out);
        o->setProperty ("runId", current.runId);
        o->setProperty ("stage", "building");
        delegate.emit ("tone3000InstallProgress", out);
    }

    const auto rewriteAndFinish = [this, namPath, irPath] (juce::String state, juce::var parameters)
    {
        if (state.isEmpty())
            return finishInstall (false, "Neural Amp Modeler is not available");

        juce::String rewritten;
        const auto result = NamStateCodec::rewrite (state,
                                                    namPath.isNotEmpty() ? std::optional { namPath }
                                                                         : std::nullopt,
                                                    irPath.isNotEmpty() ? std::optional { irPath }
                                                                        : std::nullopt,
                                                    rewritten);

        if (result != NamStateCodec::Result::ok)
        {
            // The file is on disk and perfectly usable; only the automatic
            // hand-off failed. Say which, and let the UI offer the path — a
            // NAM whose chunk layout has moved is a version problem, not a
            // reason to lose the download.
            juce::var out;
            auto* o = object (out);
            o->setProperty ("ok", false);
            o->setProperty ("runId", run.runId);
            o->setProperty ("error", "This version of Neural Amp Modeler stores its settings in a way "
                                     "Plectrify does not recognise, so the tone could not be loaded for you.");
            o->setProperty ("path", namPath.isNotEmpty() ? namPath : irPath);
            delegate.emit ("tone3000InstallFinished", out);
            run = {};
            pushState();
            return;
        }

        finishInstall (true, {}, rewritten, parameters);
    };

    if (current.moduleId.isNotEmpty() && delegate.captureModuleState)
    {
        // Start from the module's own state so the player's input gain, EQ and
        // noise gate survive the tone swap. Swapping tones is the common case;
        // resetting the amp under the player every time would not be.
        if (const auto live = delegate.captureModuleState (current.moduleId); live.isNotEmpty())
            return rewriteAndFinish (live, {});
    }

    if (! delegate.captureFactoryState)
        return finishInstall (false, "Neural Amp Modeler is not available");

    delegate.captureFactoryState (current.pluginId, rewriteAndFinish);
}

void Tone3000Service::finishInstall (bool ok,
                                     const juce::String& error,
                                     const juce::String& state,
                                     const juce::var& parameters)
{
    juce::var out;
    auto* o = object (out);
    o->setProperty ("runId", run.runId);
    o->setProperty ("ok", ok);

    if (! ok)
        o->setProperty ("error", error);
    else
    {
        o->setProperty ("state", state);
        o->setProperty ("parameters", parameters);
        o->setProperty ("moduleId", run.moduleId);
        o->setProperty ("provenance", run.provenance);
        o->setProperty ("file", run.destination.getRelativePathFrom (downloadsDirectory())
                                    .replaceCharacter ('\\', '/'));
    }

    delegate.emit ("tone3000InstallFinished", out);

    // The reconcile push: disk truth, after the stream. The page believes this
    // rather than the terminal event, which can be dropped while occluded.
    pushState();

    // Only now, with the module already playing: the rest of the tone's
    // captures follow quietly, so the variant switcher is instant and offline.
    // Handed to a job of its own first, because `run` must be free for whatever
    // the user downloads next.
    const auto follow = ok && ! run.models.isEmpty();

    if (follow)
        variants = { run.toneId, run.format, run.models, true };

    run = {};

    if (follow)
        downloadRemainingModels();
}

void Tone3000Service::downloadRemainingModels()
{
    const auto next = [this]
    {
        for (const auto& model : variants.models)
        {
            const auto modelId = (juce::int64) property (model, "id");
            const auto relative
                = Tone3000Library::modelRelativePath (variants.toneId, modelId, variants.format);

            if (relative.isEmpty())
                continue;

            const auto destination = downloadsDirectory().getChildFile (relative);

            if (destination.existsAsFile() && destination.getSize() > 0)
                continue;

            const auto url = stringProperty (model, "model_url");

            // The same allowlist the chosen model passed: a URL from the
            // network never decides what kind of file gets written.
            if (! Tone3000Library::urlMatchesFormat (url, variants.format))
                continue;

            return std::optional { std::pair { url, destination } };
        }

        return std::optional<std::pair<juce::String, juce::File>>{};
    };

    const auto nextDownload = next();

    if (! nextDownload.has_value())
    {
        // All of them are on disk. One last push so the page's picture of the
        // download folder matches it.
        variants = {};
        pushState();
        return;
    }

    CatalogueInstaller::createSharedContentDirectory (nextDownload->second.getParentDirectory());

    client.downloadModel (nextDownload->first, nextDownload->second, nullptr,
                          [this] (juce::String error)
                          {
                              // A variant that will not download is not a
                              // failure of anything the user asked for: the
                              // capture they picked is already playing. It is
                              // simply not offered offline, and the switcher
                              // fetches it on demand.
                              if (error.isNotEmpty())
                              {
                                  variants = {};
                                  pushState();
                                  return;
                              }

                              downloadRemainingModels();
                          });
}

void Tone3000Service::cancelInstall()
{
    client.cancel();
    run = {};
    variants = {};
    pushState();
}

//==============================================================================
void Tone3000Service::selectModel (const juce::var& payload)
{
    const auto requestId = stringProperty (payload, "requestId");
    const auto moduleId = stringProperty (payload, "moduleId");
    const auto toneId = intProperty (payload, "toneId");
    const auto modelId = intProperty (payload, "modelId");
    const auto format = Tone3000Library::formatFromString (stringProperty (payload, "format"));

    const auto fail = [this, requestId, moduleId] (const juce::String& error)
    {
        juce::var out;
        auto* o = object (out);
        o->setProperty ("requestId", requestId);
        o->setProperty ("moduleId", moduleId);
        o->setProperty ("ok", false);
        o->setProperty ("error", error);
        delegate.emit ("tone3000ModelSelected", out);
    };

    if (! format.has_value())
        return fail ("Plectrify cannot play that tone's format");

    const auto relative = Tone3000Library::modelRelativePath (toneId, modelId, *format);

    if (relative.isEmpty() || moduleId.isEmpty() || ! delegate.captureModuleState)
        return fail ("That capture cannot be loaded");

    const auto destination = downloadsDirectory().getChildFile (relative);

    const auto swap = [this, requestId, moduleId, relative, destination, format, modelId, fail]
    {
        // The *live* state, not the patch's: the point of switching captures is
        // to hear the same rig through another one, so the player's input gain,
        // EQ and gate stay exactly where they were set.
        const auto live = delegate.captureModuleState (moduleId);

        if (live.isEmpty())
            return fail ("That module is no longer there");

        const auto isCapture = *format == Tone3000Library::Format::nam;
        juce::String rewritten;
        const auto result = NamStateCodec::rewrite (
            live,
            isCapture ? std::optional { destination.getFullPathName() } : std::nullopt,
            isCapture ? std::nullopt : std::optional { destination.getFullPathName() },
            rewritten);

        if (result != NamStateCodec::Result::ok)
            return fail ("Plectrify could not point that module at the new capture");

        juce::var out;
        auto* o = object (out);
        o->setProperty ("requestId", requestId);
        o->setProperty ("moduleId", moduleId);
        o->setProperty ("ok", true);
        o->setProperty ("modelId", modelId);
        o->setProperty ("file", relative);
        o->setProperty ("state", rewritten);
        delegate.emit ("tone3000ModelSelected", out);
        pushState();
    };

    // Normally already on disk — the whole set comes down after an install —
    // but a patch made before that, or a variant whose download failed, is
    // fetched now rather than refused.
    if (destination.existsAsFile() && destination.getSize() > 0)
        return swap();

    const auto modelUrl = stringProperty (payload, "modelUrl");

    if (modelUrl.isEmpty())
    {
        client.getJson ("/api/v1/models/" + juce::String (modelId),
                        [this, payload, fail] (Tone3000Client::Response response)
                        {
                            if (! response.ok)
                                return fail (response.status == 404 || response.status == 403
                                                 ? "That capture is no longer available on TONE3000"
                                                 : response.error);

                            auto* retry = payload.getDynamicObject();

                            if (retry == nullptr)
                                return fail ("That capture cannot be loaded");

                            retry->setProperty ("modelUrl", stringProperty (response.json, "model_url"));
                            selectModel (payload);
                        });
        return;
    }

    if (! Tone3000Library::urlMatchesFormat (modelUrl, *format))
        return fail ("That download does not look like the right kind of file");

    CatalogueInstaller::createSharedContentDirectory (destination.getParentDirectory());

    client.downloadModel (modelUrl, destination, nullptr,
                          [swap, fail] (juce::String error)
                          {
                              if (error.isNotEmpty())
                                  return fail (error);

                              swap();
                          });
}

//==============================================================================
void Tone3000Service::verify (const juce::var& payload)
{
    juce::Array<juce::var> missing;
    const auto root = downloadsDirectory();

    if (const auto* files = property (payload, "files").getArray())
    {
        for (const auto& entry : *files)
        {
            const auto relative = entry.toString();

            // A patch document is not necessarily one we wrote, so its `file`
            // is validated rather than trusted — an unsafe path is reported
            // missing rather than resolved against the root.
            if (! Tone3000Library::isSafeRelativePath (relative)
                || ! root.getChildFile (relative).existsAsFile())
                missing.add (relative);
        }
    }

    juce::var out;
    auto* o = object (out);
    o->setProperty ("requestId", stringProperty (payload, "requestId"));
    o->setProperty ("missing", missing);
    delegate.emit ("tone3000Verified", out);
}

void Tone3000Service::repair (const juce::var& payload)
{
    const auto requestId = stringProperty (payload, "requestId");
    const auto toneId = intProperty (payload, "toneId");
    const auto modelId = intProperty (payload, "modelId");
    const auto format = Tone3000Library::formatFromString (stringProperty (payload, "format"));
    const auto state = stringProperty (payload, "state");

    const auto fail = [this, requestId] (const juce::String& error)
    {
        juce::var out;
        auto* o = object (out);
        o->setProperty ("requestId", requestId);
        o->setProperty ("ok", false);
        o->setProperty ("error", error);
        delegate.emit ("tone3000Repaired", out);
    };

    if (! format.has_value())
        return fail ("Plectrify cannot play that tone's format");

    const auto relative = Tone3000Library::modelRelativePath (toneId, modelId, *format);

    if (relative.isEmpty())
        return fail ("That patch is missing a tone identifier");

    const auto destination = downloadsDirectory().getChildFile (relative);

    // Repointing the state at *this* machine's copy is the whole point: a patch
    // saved on the other operating system names a path that does not exist
    // here, and rewriting it is what makes the patch playable rather than lost.
    const auto repoint = [this, requestId, destination, format, state, fail]
    {
        juce::String rewritten;
        const auto isCapture = *format == Tone3000Library::Format::nam;
        const auto result = NamStateCodec::rewrite (
            state,
            isCapture ? std::optional { destination.getFullPathName() } : std::nullopt,
            isCapture ? std::nullopt : std::optional { destination.getFullPathName() },
            rewritten);

        if (result != NamStateCodec::Result::ok)
            return fail ("Plectrify could not update that patch's settings");

        juce::var out;
        auto* o = object (out);
        o->setProperty ("requestId", requestId);
        o->setProperty ("ok", true);
        o->setProperty ("state", rewritten);
        delegate.emit ("tone3000Repaired", out);
        pushState();
    };

    if (destination.existsAsFile() && destination.getSize() > 0)
        return repoint();

    const auto modelUrl = stringProperty (payload, "modelUrl");

    if (modelUrl.isEmpty())
    {
        // No URL to hand: fetch the model record first, then come back through
        // the same path with one.
        client.getJson ("/api/v1/models/" + juce::String (modelId),
                        [this, payload, fail] (Tone3000Client::Response response)
                        {
                            if (! response.ok)
                                return fail (response.status == 404 || response.status == 403
                                                 ? "That tone is no longer available on TONE3000"
                                                 : response.error);

                            auto* retry = payload.getDynamicObject();

                            if (retry == nullptr)
                                return fail ("Could not repair that patch");

                            retry->setProperty ("modelUrl", stringProperty (response.json, "model_url"));
                            repair (payload);
                        });
        return;
    }

    if (! Tone3000Library::urlMatchesFormat (modelUrl, *format))
        return fail ("That download does not look like the right kind of file");

    CatalogueInstaller::createSharedContentDirectory (destination.getParentDirectory());

    client.downloadModel (modelUrl, destination, nullptr,
                          [repoint, fail] (juce::String error)
                          {
                              if (error.isNotEmpty())
                                  return fail (error);

                              repoint();
                          });
}

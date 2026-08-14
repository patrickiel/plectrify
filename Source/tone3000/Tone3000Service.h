#pragma once

#include "Tone3000Auth.h"
#include "Tone3000Client.h"
#include "Tone3000Library.h"
#include "Tone3000SelectUrl.h"
#include "Tone3000WindowState.h"

#include <JuceHeader.h>

class Tone3000BrowserWindow;

/**
    The message-thread face of the TONE3000 integration: the session, the
    downloads, and the one operation only the native side can perform — turning
    a downloaded capture into a plugin state a module will accept.

    THERE IS NO IN-APP BROWSER. Browsing happens on TONE3000's own pages, in
    Tone3000BrowserWindow, and a tone picked there comes back through the OAuth
    callback and is downloaded, chosen and applied with no further question —
    see `beginInstall` for what "chosen" means when a tone carries several
    models. The page's part is the button that opens the window and the patch
    document written when a tone lands; it never sees a tone list, a token or a
    model URL.

    MainComponent owns one of these and forwards the bridge events to it. Every
    method here is called on the message thread and returns immediately; answers
    arrive through the delegate's `emit`, so a slow network never blocks the UI.

    WHAT THIS DOES NOT DO. It never writes a patch. A patch is TypeScript's
    document (see the persistence rules in AGENTS.md), and the split is kept
    exactly there: C++ produces the model file on disk and the rewritten opaque
    state, the page writes patches/<id>.patch through the same sandboxed
    writeFile every other patch uses. Nothing about the patch format moves in
    here, and no model bytes ever cross the bridge.
*/
class Tone3000Service
{
public:
    /** Everything the service needs from the rest of the app, injected rather
        than reached for, so it depends on no slice above it. */
    struct Delegate
    {
        /** This module's current plugin state, base64, or empty if there is no
            such module. Starting from the live state is what lets a tone swap
            keep the player's own gain, EQ and noise gate. */
        std::function<juce::String (const juce::String& moduleId)> captureModuleState;

        /** Instantiate `pluginId` off the graph and answer with its factory
            state and its parameter list, or an empty state on failure. Async,
            because plugin instantiation is. Used when a patch is being created
            from the drawer with no module to start from — which is why no
            template blob has to be shipped and kept in step with NAM's version. */
        std::function<void (const juce::String& pluginId,
                            std::function<void (juce::String state, juce::var parameters)>)>
            captureFactoryState;

        /** The installed Neural Amp Modeler's plugin id, or empty if the scan
            has not found one. Asked of the host rather than carried in from the
            page, because it now ships with Plectrify: the page has no part in
            deciding whether it is there, and a browse must not depend on the
            page having noticed it yet. */
        std::function<juce::String()> findNamPluginId;

        /** Send an event to the page. */
        std::function<void (const juce::String& eventId, const juce::var&)> emit;
    };

    explicit Tone3000Service (Delegate);
    ~Tone3000Service();

    // ── Bridge entry points. Each takes the event's payload verbatim. ─────────

    /** Push the current session state. Also the reconcile push after an install
        run: the page trusts this, not the progress stream, because a terminal
        event can be dropped while the window is occluded. */
    void pushState();

    /** Open the TONE3000 window: on the page it was last showing if there is a
        live attempt to restore, otherwise on a fresh authorize URL. The payload
        carries the browse context — which module a tone should land on, and the
        Neural Amp Modeler instance to build its state from — held for the
        window's lifetime rather than round-tripped through TONE3000. */
    void connect (const juce::var& payload);
    void disconnect();
    void cancelInstall();
    void verify (const juce::var& payload);
    void repair (const juce::var& payload);
    /** Switch a module to another of its tone's captures: point the plugin's
        state at that model's file and hand the rewritten state back. The
        player's own gain, EQ and gate ride along, because the state being
        rewritten is the live one. */
    void selectModel (const juce::var& payload);
    void markSplashSeen();

private:
    struct InstallRun
    {
        juce::String runId;
        /** Every model of the tone, in the order TONE3000 listed them. Carried
            into the patch's provenance so the variant switcher has the set
            without asking the network again. */
        juce::Array<juce::var> models;
        juce::int64 toneId = 0;
        juce::int64 modelId = 0;
        juce::String moduleId;
        juce::String pluginId;
        Tone3000Library::Format format = Tone3000Library::Format::nam;
        juce::var provenance;
        juce::File destination;
        bool active = false;
    };

    void loadSession();
    void saveCredentials();
    void saveLocalState();
    juce::File sessionDirectory() const;
    juce::File downloadsDirectory() const;

    void handleCallback (const juce::String& url);
    /** Put the window away without destroying it — see `browserWindow`. */
    void hideBrowserWindow();
    /** TONE3000's "your session has expired" page, which is where a restored
        flow lands rather than at any callback we could verify. */
    bool isSessionExpiredPage (const juce::String& url) const;
    void restartFlow();
    void closeBrowserWindow();
    void restorePlaceAndScroll (const juce::String& url, const juce::String& place);
    void fetchUserThenProbeAccess();
    void probeApiAccess();

    /** Turn the tone the user picked into a patch: read the tone, merge both
        model selections, choose one (Tone3000Library::chooseModel) and run it
        through the download-and-rewrite pipeline. No UI stands between the pick
        and the sound. */
    void beginInstall (juce::int64 toneId, juce::int64 modelId);
    void startDownload (const juce::var& tone, const juce::var& model);
    void failInstall (const juce::String& error);

    /** Fetch the tone's remaining models, one at a time, after the chosen one
        has already been handed over.

        A tone is usually several captures of the same amp — six of an AC30, say:
        two channels at three gain settings — and which of them suits a song is
        a question only answered by hearing them. So the whole set comes down,
        and switching between them afterwards costs nothing and works offline.
        Quiet by design: the module is already playing, and this is the rest of
        the box arriving. */
    void downloadRemainingModels();

    juce::String authorizeUrl() const;

    void buildPatchState (const InstallRun&, juce::String namPath, juce::String irPath);
    void finishInstall (bool ok,
                        const juce::String& error,
                        const juce::String& state = {},
                        const juce::var& parameters = {});

    juce::var describeDownloads() const;

    Delegate delegate;
    Tone3000Client client;

    Tone3000Auth::Pkce pending;
    juce::String pendingToneId;
    juce::String pendingModelId;
    bool windowOpen = false;

    /** Where a tone the user picks should land. Set when the window is opened
        and held until it closes, because TONE3000 knows nothing of modules and
        cannot carry it round the flow for us. */
    juce::String browseModuleId;
    juce::String browsePluginId;
    /** The architecture the window was opened for, and what `chooseModel`
        prefers. Single-valued, and **omitting it is not "all"** — see
        Tone3000Auth::AuthorizeOptions. */
    juce::String browseArchitecture { "2" };

    /** What this build's key is allowed to do. 'prompt' is TONE3000's free
        tier: the select_tone and load_tone flows plus the bounded list
        endpoints. 'full' adds search. Everything Plectrify now does is a prompt
        flow, so this decides whether the account is usable at all rather than
        which tabs exist — there are no tabs any more. */
    juce::String apiAccess { "none" };
    bool splashSeen = false;

    /** Where the window was, restored on the next open and saved whenever it
        moves or resizes. */
    Tone3000WindowState::Bounds windowBounds;

    /** And what it was showing: a Select-flow page with the single-use
        `authorization_id` stripped out (see Tone3000SelectUrl). Kept beside the
        bounds in plain state.json because that is all it is — a path and some
        filters, no credential and no session. The next opening starts a fresh
        flow as always and re-attaches this to the authorization that flow hands
        out, which is why it can be restored at all: saving the URL whole landed
        on their "session expired" page every time, because picking a tone
        spends the authorization in it. */
    juce::String windowPlace;
    /** One restore per opening. The restore is itself a navigation, and acting
        on it again would put the window in a loop. */
    bool placeRestored = false;
    /** How far down that page the reader was. Restored after the place, and
        only ever with it: an offset into a different page is a number with no
        meaning. */
    int windowScroll = 0;
    /** A scroll restore waiting for its page to arrive. While this is set the
        page's own reports are ignored — a page that has just loaded is at the
        top, and believing it would overwrite the offset being restored. */
    int scrollToRestore = 0;

    /** Hidden rather than destroyed once it has been opened.

        Closing the window keeps the page alive, so reopening it in the same
        session is instant and *nothing* has to be reconstructed — the tone list,
        the search that was typed, the scroll position, all still there. The
        saved place and offset are what the next session (or a flow that has
        been spent) starts from; they are the fallback, not the mechanism.

        A picked tone spends the flow's authorization, so the page left behind
        cannot serve a second pick. That is what `flowSpent` records: the next
        showing re-authorises and restores the place, instead of handing the
        user a window that will fail the moment they choose something. */
    bool flowSpent = false;
    /** Automatic flow restarts since this window opened. Bounded at one: a
        restart is triggered by a page load, and an expiry loop would otherwise
        reload the window under the user forever. */
    int autoRestarts = 0;

    std::unique_ptr<Tone3000BrowserWindow> browserWindow;
    InstallRun run;

    /** The variant fetch that follows an install, kept apart from `run` so it
        cannot block the next one: the user is free to go and download another
        tone while the rest of this one's captures are still arriving. */
    struct VariantFetch
    {
        juce::int64 toneId = 0;
        Tone3000Library::Format format = Tone3000Library::Format::nam;
        juce::Array<juce::var> models;
        bool active = false;
    };

    VariantFetch variants;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Tone3000Service)
};

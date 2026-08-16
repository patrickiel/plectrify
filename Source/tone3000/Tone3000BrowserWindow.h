#pragma once

#include "Tone3000WindowState.h"

#include <JuceHeader.h>

#include <functional>

/**
    TONE3000, as its own window. Sign-in, the whole catalogue, and picking a
    tone all happen on TONE3000's own pages in here — there is no in-app browser
    any more, and this window *is* the product surface for everything TONE3000
    offers.

    A second WebBrowserComponent rather than the system browser, because that is
    what TONE3000's integration requirements describe — the splash, the sign-in
    and the browse view all happen inside the host — and because a persistent
    profile is what makes the second sign-in silent: the magic-link session
    cookie lives in this window's own user-data folder.

    HOW THE CODE COMES BACK. TONE3000 finishes by redirecting to the registered
    redirect URI. That URI is a real page on plectrify.com, but in the normal
    path it is never fetched: `pageAboutToLoad` sees the navigation, reads the
    query and returns false, cancelling it. `pageFinishedLoading` is a second
    chance for the case where a server-side redirect does not surface as a
    navigation we can veto — then the static page really does load, says "you
    can close this window", and we read the URL from there. Delivery is
    idempotent, so both firing is harmless.

    WHERE IT COMES BACK. The window reports every move and resize, and opens
    from what was reported last time — see Tone3000WindowState for the
    multi-monitor rule. Its *page* comes back too, but not from its navigations:
    the Select UI is a single-page app that changes route and filters from
    inside the document, so where the reader is, is polled out of the page
    (`onSeen`) rather than watched for on the way in. The landing is still
    reported, because two URLs have to be recognised on arrival — the redirect
    that carries a picked tone, and their "session expired" page, which is how a
    flow they will not honour announces itself.

    On Windows this is a second WebView2 environment in one process. Two
    environments sharing a user-data folder must agree on their options, so this
    one gets a folder of its own — named WebView2-Tone3000 so the dev loop's
    orphan killer (scripts/windows.ts, which globs *\\Plectrify\\WebView2*) still
    reaps it. It must also be destroyed before the main web view, for the same
    async COM teardown reason MainComponent's destructor documents.
*/
class Tone3000BrowserWindow : public juce::DocumentWindow,
                              private juce::Timer
{
public:
    /** Everything the owner wants to hear about. Each may be null. */
    struct Callbacks
    {
        /** The intercepted redirect URI, exactly once per window. */
        std::function<void (juce::String)> onCallback;
        /** The page the window has settled on, and where the window now is.
            One callback for both because the owner acts on both: it saves the
            placement, and it watches the URL for the one page that means this
            flow is dead. */
        std::function<void (juce::String url, Tone3000WindowState::Bounds)> onPlaceChanged;
        /** What the *document* says it is showing, and how far down it the user
            has scrolled, sampled once a second while they read.

            Separate from `onPlaceChanged`, and the more truthful of the two:
            their catalogue is a single-page app, so opening a tone and every
            filter applied to the grid change the route without a navigation
            anyone outside the page can observe. `onPlaceChanged` sees the
            landing and nothing after it.

            `scrollY` is -1 for a page that cannot answer — a locked document
            behind a modal reports the top however far down the reader is, and
            believing it is what used to lose their place on every pick. */
        std::function<void (juce::String url, int scrollY)> onSeen;
        /** Fires once, however the window went away — so a UI waiting on the
            flow can never be left hanging. */
        std::function<void()> onClosed;
    };

    /** @param startUrl     the authorize URL to open on
        @param redirectUri  the URI whose navigation is intercepted
        @param saved        last known placement; ignored if it does not land on
                            a display attached now */
    /** `saved` is taken **by value**, and that is load-bearing rather than
        idiomatic: the owner passes its own stored bounds, and constructing a
        window emits placement reports (a default 128×128 one, before this
        constructor has placed anything) which the owner writes straight back
        into that member. Held by reference, the rectangle to restore was
        overwritten by the junk report before it could be read — the window
        restored itself onto its own default, every time. */
    Tone3000BrowserWindow (const juce::String& startUrl,
                           const juce::String& redirectUri,
                           Tone3000WindowState::Bounds saved,
                           Callbacks);

    ~Tone3000BrowserWindow() override;

    /** Send the window somewhere else without tearing it down — how the user is
        put back on the page they were last reading, inside the flow this window
        already holds.

        Movement *within* a flow only. Navigating to a fresh authorize URL is
        what TONE3000 answers with "Error code: 9" once this view has carried
        one, so a new flow means a new window — see
        Tone3000Service::openBrowserWindow. */
    void goTo (const juce::String& url);

    /** Start a fresh flow *in* this window: the web view is replaced, the
        window itself never leaves the screen.

        The view has to go — a view that has already carried a flow answers a
        second authorize navigation with TONE3000's "Error code: 9", which is
        why `goTo` is movement within a flow only. The window does not, and
        that is the whole point: replacing the DocumentWindow as well means it
        vanishes from the screen and the taskbar and comes back with the focus
        and stacking order of something newly opened, which reads as a close and
        a reopen. Swapping only the content leaves it exactly where it was,
        black while the new page arrives.

        Not to be called from inside the browser's own callbacks: the object it
        deletes is the one calling. Tone3000Service defers it. */
    void renew (const juce::String& startUrl);

    /** Bring a hidden window back.

        More than `setVisible (true)`: a window that has spent time hidden comes
        back with a web view the OS was free to throttle, suspend or simply
        never repaint, and the result is a frame of chrome with nothing in it.
        Re-asserting the content's bounds is what makes it lay out and paint
        again. A view that came back with no *page* is not this method's problem
        and must not be: reloading one is the "Error code: 9" move above. The
        owner asks `getCurrentUrl()` first and builds a new window instead. */
    void show();

    /** Scroll the current page back to where the user had it, once it has
        enough content to get there. See the definition: a page whose images
        load lazily is shorter than its final self for a moment, so this is
        attempted repeatedly and gives up rather than fighting the page. */
    void restoreScroll (int scrollY);

    /** The window's current page and placement, for a save the owner initiates
        (on close, on quit) rather than one a move triggered. */
    juce::String getCurrentUrl() const;
    Tone3000WindowState::Bounds getPlacement() const;

    void closeButtonPressed() override;
    void moved() override;
    void resized() override;

private:
    class Browser;

    /** Samples the page's address and scroll offset. Polled rather than driven
        by events, because a listener inside the page would have no way to call
        back out: this window deliberately has no native bridge — TONE3000's
        pages must not be able to reach Plectrify's — so the traffic only goes
        one way, and one small question per second is the price of that. */
    void timerCallback() override;

    void reportPlace();

    /** Build the web view and point it at `startUrl`. Shared by construction
        and by `renew`, so a replaced view is the same view in every respect —
        same options, same user-data folder, same interception. */
    void buildBrowser (const juce::String& startUrl);

    Callbacks callbacks;
    /** Held rather than consumed at construction: `renew` builds another
        browser, and it needs both of these to do it. */
    juce::String redirectUri;
    juce::WebBrowserComponent::Options browserOptions;
    std::unique_ptr<Browser> browser;
    /** Un-maximised bounds. Tracked rather than read back on demand because
        `getBounds` reports the maximised rectangle while maximised, and coming
        back from full screen to a full-screen-sized window is not a restore. */
    juce::Rectangle<int> restoredBounds;
    /** Nothing is reported before the constructor has finished placing the
        window or after the destructor has started taking it apart. Both ends
        emit resizes that describe a window nobody has ever seen, and both were
        being saved as somewhere to come back to. */
    bool ready = false;
    bool tearingDown = false;
    /** The last offset and address reported, so a page nobody has touched costs
        nothing. */
    int lastScrollY = 0;
    juce::String lastSeenUrl;
    /** A restore in progress: the target, and how many attempts are left before
        it is accepted that the page is simply not that long. */
    int pendingScrollY = 0;
    int scrollAttemptsLeft = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Tone3000BrowserWindow)
};

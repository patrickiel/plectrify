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
    multi-monitor rule. Its *page* is not restored, and cannot be: TONE3000's
    Select UI lives at one single-use URL that never changes as the user
    browses, so every opening starts a fresh authorize URL (Tone3000Service
    says more). The page it settles on is still reported, because one URL does
    have to be recognised — their "session expired" page, which is how a flow
    they will not honour announces itself.

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
        /** How far down that page the user has scrolled, sampled while they
            read. Separate from `onPlaceChanged` because it arrives on its own
            schedule — the answer comes back from the page asynchronously. */
        std::function<void (int scrollY)> onScrolled;
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

    /** Send the window somewhere else without tearing it down — how a flow
        TONE3000 no longer accepts is replaced by a fresh one without the window
        blinking out of existence under the user. */
    void goTo (const juce::String& url);

    /** Bring a hidden window back.

        More than `setVisible (true)`: a window that has spent time hidden comes
        back with a web view the OS was free to throttle, suspend or simply
        never repaint, and the result is a frame of chrome with nothing in it.
        Re-asserting the content's bounds is what makes it lay out and paint
        again, and `reloadIfBlank` covers the case where it came back with no
        page at all rather than merely an unpainted one. */
    void show (const juce::String& reloadIfBlank);

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

    /** Samples the page's scroll offset. Polled rather than driven by a scroll
        event, because a listener inside the page would have no way to call back
        out: this window deliberately has no native bridge — TONE3000's pages
        must not be able to reach Plectrify's — so the traffic only goes one way,
        and one small question per second is the price of that. */
    void timerCallback() override;

    void reportPlace();

    Callbacks callbacks;
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
    /** The last offset reported, so an unmoved page costs nothing. */
    int lastScrollY = 0;
    /** A restore in progress: the target, and how many attempts are left before
        it is accepted that the page is simply not that long. */
    int pendingScrollY = 0;
    int scrollAttemptsLeft = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Tone3000BrowserWindow)
};

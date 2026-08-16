#include "Tone3000BrowserWindow.h"

#include "AppPaths.h"

//==============================================================================
class Tone3000BrowserWindow::Browser final : public juce::WebBrowserComponent
{
public:
    Browser (const juce::String& redirectUriIn,
             std::function<void (juce::String)> onCallbackIn,
             std::function<void()> onPageChangedIn,
             const juce::WebBrowserComponent::Options& options)
        : juce::WebBrowserComponent (options),
          redirectUri (redirectUriIn.trimCharactersAtEnd ("/")),
          onCallback (std::move (onCallbackIn)),
          onPageChanged (std::move (onPageChangedIn))
    {
    }

    bool pageAboutToLoad (const juce::String& url) override
    {
        if (! isCallback (url))
        {
            currentUrl = url;
            return true;
        }

        // Cancelled: the redirect URI is a real page, but there is no reason to
        // fetch it when the only thing we want is the query it carries. It is
        // also never recorded as the current page — a redeemed redirect is the
        // one URL that must not be what the window reopens on.
        deliver (url);
        return false;
    }

    void pageFinishedLoading (const juce::String& url) override
    {
        // The fallback for a redirect that does not surface as a vetoable
        // navigation. `deliver` is idempotent, so the two hooks racing is fine.
        if (isCallback (url))
        {
            deliver (url);
            return;
        }

        // Reported on completion rather than on intent: a page that failed to
        // load, or one the user navigated away from before it arrived, is not
        // somewhere to reopen on.
        currentUrl = url;

        if (onPageChanged)
            onPageChanged();
    }

    void newWindowAttemptingToLoad (const juce::String& url) override
    {
        // TONE3000's pages carry target=_blank links. JUCE's default is to do
        // nothing, which would leave such a link silently dead; opening a real
        // popup would strand the user in a window with no chrome and no way
        // back. Navigating in place is the only option that keeps the flow
        // reachable — and the callback interception still applies to it.
        goToURL (url);
    }

    juce::String getCurrentUrl() const { return currentUrl; }

    /** Arm the callback again for a new sign-in in this same browser.

        `delivered` exists so one attempt cannot report twice — two hooks race
        to deliver the redirect on purpose. But it is per *browser*, and a
        browser now outlives an attempt: without this, the second tone anyone
        downloaded in a session would be picked on TONE3000 and never arrive,
        because the callback had already been spent by the first. */
    void armForNewFlow() { delivered = false; }

private:
    bool isCallback (const juce::String& url) const
    {
        // Matched on the path, not as a bare prefix: a host that merely starts
        // the same way ("plectrify.com.example.invalid") must not be mistaken
        // for the callback.
        const auto base = url.upToFirstOccurrenceOf ("?", false, false).trimCharactersAtEnd ("/");
        return base == redirectUri;
    }

    void deliver (const juce::String& url)
    {
        if (std::exchange (delivered, true))
            return;

        if (onCallback)
            onCallback (url);
    }

    const juce::String redirectUri;
    std::function<void (juce::String)> onCallback;
    std::function<void()> onPageChanged;
    juce::String currentUrl;
    bool delivered = false;
};

//==============================================================================
namespace
{
/** How far down the page the reader is, or -1 for "do not believe me".

    `scrollingElement` first, `window.scrollY` second: which of the two answers
    depends on how the document is laid out, and asking for both costs nothing.

    THE -1 IS THE WHOLE POINT, and it is what a picked tone taught us. Opening
    a tone puts a modal over the grid and locks the document behind it, which is
    the ordinary way to stop the page scrolling under a dialog — and a locked
    document reports an offset of **0**, however far down the reader actually
    is. Believed, that zero was written straight over a perfectly good position
    (7533, in the trace that found this), so the grid came back at the top after
    every pick. A locked page is not a page at the top; it is a page with no
    answer to give, and that is what this says. Whether it is locked with
    `overflow: hidden` or by pinning the body is up to them, so both are
    recognised, as is a document with nothing to scroll at all. */
const juce::String scrollExpression =
    "(() => { const e = document.scrollingElement || document.documentElement; "
    "const b = getComputedStyle(document.body), h = getComputedStyle(document.documentElement); "
    "if (b.position === 'fixed' || b.overflow === 'hidden' || b.overflowY === 'hidden' "
    "|| h.overflow === 'hidden' || h.overflowY === 'hidden') return -1; "
    "return Math.round(e ? e.scrollTop : (window.scrollY || 0)); })()";

/** What the reader is looking at: that offset, then a space, then the page's
    own URL.

    The URL is asked for rather than taken from the navigation hooks because
    **TONE3000's catalogue is a single-page app**. Opening a tone, and every
    filter and search the user applies, changes the route from inside the
    document — `pageFinishedLoading` fires for none of it, and the window's idea
    of where it was stayed "/api/v1/select" for a whole session of browsing
    (which is precisely the main route it kept coming back to). The document is
    the only thing that knows, so the document is asked.

    Together they are the entirety of what Plectrify ever asks these pages: one
    number and one address, read once a second, never anything written back
    except a scroll position the user themselves left. Nothing else is
    inspected, and nothing is collected or sent anywhere. */
const juce::String readPlaceScript =
    "(() => (" + scrollExpression + ") + ' ' + location.href)()";

juce::Array<juce::Rectangle<int>> attachedDisplays()
{
    juce::Array<juce::Rectangle<int>> areas;

    for (const auto& display : juce::Desktop::getInstance().getDisplays().displays)
        // The *user* area, so a window is never restored underneath the Windows
        // taskbar or the mac menu bar, where its title bar cannot be grabbed.
        areas.add (display.userArea);

    return areas;
}
} // namespace

//==============================================================================
Tone3000BrowserWindow::Tone3000BrowserWindow (const juce::String& startUrl,
                                              const juce::String& redirectUriIn,
                                              Tone3000WindowState::Bounds saved,
                                              Callbacks callbacksIn)
    : juce::DocumentWindow ("TONE3000",
                            juce::Colours::black,
                            juce::DocumentWindow::closeButton | juce::DocumentWindow::maximiseButton
                                | juce::DocumentWindow::minimiseButton),
      callbacks (std::move (callbacksIn)),
      redirectUri (redirectUriIn)
{
   #if JUCE_WINDOWS
    // Its own user-data folder. Two WebView2 environments in one process must
    // agree on their options to share one, and this window's differ from the
    // UI's — a folder each is the only lock-free answer. The name keeps it
    // inside the dev loop's orphan-killer glob (see scripts/windows.ts).
    const auto dataFolder = plectrify::appDataDir().getChildFile ("WebView2-Tone3000");
    dataFolder.createDirectory();
   #endif

    browserOptions = juce::WebBrowserComponent::Options{}
       #if JUCE_WINDOWS
        .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
        .withWinWebView2Options (juce::WebBrowserComponent::Options::WinWebView2{}
                                     .withUserDataFolder (dataFolder)
                                     .withBackgroundColour (juce::Colours::black))
       #endif
        // Deliberately no native integration and no resource provider: this
        // window shows a third party's pages, and nothing on them may reach
        // Plectrify's bridge or its file sandbox.
        ;

    // A native title bar on both platforms, like PluginEditorWindow: this is
    // someone else's page, and dressing it in Plectrify's chrome would imply we
    // drew what is inside it.
    setUsingNativeTitleBar (true);
    setResizable (true, false);

    // Bigger than the old sign-in window's 480×760, because this is now the
    // whole catalogue rather than one form — but only as the *first* size: from
    // the second opening onwards it is whatever the user left it at.
    const auto fallback = juce::Rectangle<int> { 1100, 820 }.withCentre (
        juce::Desktop::getInstance().getDisplays().getPrimaryDisplay() != nullptr
            ? juce::Desktop::getInstance().getDisplays().getPrimaryDisplay()->userArea.getCentre()
            : juce::Point<int> { 700, 450 });

    restoredBounds = Tone3000WindowState::place (saved, attachedDisplays(), fallback);

    Tone3000WindowState::trace ("open  saved=" + saved.toRectangle().toString()
                                + (saved.maximised ? " (max)" : "") + "  placed="
                                + restoredBounds.toString() + "  displays="
                                + juce::String (attachedDisplays().size()));

    setBounds (restoredBounds);
    setVisible (true);

    // After the bounds, or the un-maximised size the user comes back to would
    // be whatever the window happened to be created at.
    if (saved.maximised)
        setFullScreen (true);

    toFront (true);

    // Last: from here on the window's own reports describe a real window.
    ready = true;
    reportPlace();
    startTimer (1000);

    // After the window is placed, as the navigation always was: the page it
    // loads is measured against the client area it arrives into.
    buildBrowser (startUrl);
}

void Tone3000BrowserWindow::buildBrowser (const juce::String& startUrl)
{
    browser = std::make_unique<Browser> (redirectUri,
                                         [this] (juce::String url)
                                         {
                                             // Forwarded rather than moved into
                                             // the browser: a replacement needs
                                             // the same callback, and the one
                                             // the owner gave is held here.
                                             if (callbacks.onCallback)
                                                 callbacks.onCallback (std::move (url));
                                         },
                                         [this] { reportPlace(); },
                                         browserOptions);

    setContentNonOwned (browser.get(), false);
    browser->goToURL (startUrl);
}

Tone3000BrowserWindow::~Tone3000BrowserWindow()
{
    // FIRST, before anything else here. `clearContentComponent` resizes the
    // window to fit the content it no longer has, which reaches `resized()` —
    // and a placement reported from inside the destructor overwrote the
    // perfectly good bounds the owner had just saved with a 128×128 stub. The
    // window's size stopped being restored at all, and the cause was the save
    // on the way out, not the restore on the way in.
    tearingDown = true;
    stopTimer();

    // Explicit, and before the window's own teardown: on Windows the browser
    // holds COM objects whose release is asynchronous, and the content
    // component must not outlive its parent's peer.
    clearContentComponent();
    browser.reset();
}

void Tone3000BrowserWindow::goTo (const juce::String& url)
{
    if (browser == nullptr)
        return;

    browser->armForNewFlow();
    browser->goToURL (url);
}

void Tone3000BrowserWindow::renew (const juce::String& startUrl)
{
    // Anything being restored belonged to the page that is going: a scroll
    // offset chased into the view about to be destroyed, and the last offset
    // reported out of it.
    pendingScrollY = 0;
    scrollAttemptsLeft = 0;
    lastScrollY = 0;
    lastSeenUrl = {};

    // Cleared before the browser goes, for the same reason the destructor does
    // it in that order — the content component must not outlive its parent's
    // hold on it. `tearingDown` covers the resize this provokes: the window is
    // momentarily fitted to no content at all, and that 128×128 report is
    // exactly the one that used to be saved as somewhere to come back to.
    const auto wasTearingDown = std::exchange (tearingDown, true);
    clearContentComponent();
    browser.reset();
    tearingDown = wasTearingDown;

    buildBrowser (startUrl);
}

void Tone3000BrowserWindow::show()
{
    setVisible (true);
    toFront (true);

    if (browser == nullptr)
        return;

    browser->setVisible (true);
    // Through the window rather than the browser: ResizableWindow owns the
    // content's bounds, and setting them behind its back is how a content
    // component ends up the wrong size after a restore.
    resized();
    browser->repaint();

    // Deliberately nothing about a blank page here. A view that came back empty
    // used to be re-navigated to a fresh authorize URL, which is exactly what
    // TONE3000 answers with "Error code: 9" — so the owner checks
    // `getCurrentUrl()` before deciding to show this window at all, and builds a
    // new one instead when there is no page left in it.
}

void Tone3000BrowserWindow::restoreScroll (int scrollY)
{
    // Attempted, not commanded. TONE3000's grids load their images lazily, so
    // for the first moment after a page arrives the document is shorter than it
    // will be and a scroll to the saved offset is silently clamped. Rather than
    // guess at a delay, ask once a second and stop as soon as the page reports
    // it got there — or after ten tries, which is a page that is simply not
    // that long any more (a filter that now matches less, a tone whose page has
    // shrunk). Landing part-way down is still nearer than the top.
    if (scrollY <= 0)
        return;

    pendingScrollY = scrollY;
    scrollAttemptsLeft = 10;
}

void Tone3000BrowserWindow::timerCallback()
{
    // Nothing is asked of a page nobody is looking at. Both of these run
    // through the browser, and a hidden WebView2 is throttled or suspended by
    // the OS, so the answers would be queued rather than given — and a queue of
    // them is what greets the window when it comes back.
    if (tearingDown || browser == nullptr || ! isVisible())
        return;

    if (scrollAttemptsLeft > 0)
    {
        --scrollAttemptsLeft;
        browser->evaluateJavascript ("window.scrollTo(0, " + juce::String (pendingScrollY) + ");"
                                     + scrollExpression,
                                     [this] (juce::WebBrowserComponent::EvaluationResult result)
                                     {
                                         if (const auto* value = result.getResult())
                                             if ((int) *value >= pendingScrollY)
                                                 scrollAttemptsLeft = 0;
                                     });
        return;
    }

    browser->evaluateJavascript (readPlaceScript,
                                 [this] (juce::WebBrowserComponent::EvaluationResult result)
                                 {
                                     const auto* value = result.getResult();

                                     if (value == nullptr || tearingDown)
                                         return;

                                     // "<offset> <url>" — see readPlaceScript.
                                     const auto answer = value->toString();
                                     const auto scrollY =
                                         answer.upToFirstOccurrenceOf (" ", false, false)
                                             .getIntValue();
                                     const auto url =
                                         answer.fromFirstOccurrenceOf (" ", false, false).trim();

                                     // A page that has no answer worth having —
                                     // see scrollExpression — still knows what
                                     // it is, so the offset alone is dropped and
                                     // the last one reported stands.
                                     if (url == lastSeenUrl && (scrollY < 0 || scrollY == lastScrollY))
                                         return;

                                     lastSeenUrl = url;

                                     if (scrollY >= 0)
                                         lastScrollY = scrollY;

                                     if (callbacks.onSeen)
                                         callbacks.onSeen (url, scrollY);
                                 });
}

juce::String Tone3000BrowserWindow::getCurrentUrl() const
{
    return browser != nullptr ? browser->getCurrentUrl() : juce::String();
}

Tone3000WindowState::Bounds Tone3000BrowserWindow::getPlacement() const
{
    // Read fresh unless maximised, where the live rectangle is the screen's and
    // the size to come back down to is the tracked one.
    const auto rectangle = isFullScreen() ? restoredBounds : getBounds();

    Tone3000WindowState::Bounds bounds;
    bounds.x = rectangle.getX();
    bounds.y = rectangle.getY();
    bounds.width = rectangle.getWidth();
    bounds.height = rectangle.getHeight();
    bounds.maximised = isFullScreen();
    return bounds;
}

void Tone3000BrowserWindow::moved()
{
    juce::DocumentWindow::moved();
    reportPlace();
}

void Tone3000BrowserWindow::resized()
{
    juce::DocumentWindow::resized();
    reportPlace();
}

void Tone3000BrowserWindow::reportPlace()
{
    // See `ready`: a window still being built, or already being taken apart,
    // reports sizes nobody chose.
    if (! ready || tearingDown)
        return;

    // While maximised the window's own bounds are the screen's, which is not a
    // size to restore to — so only the un-maximised rectangle is tracked, and
    // the maximised flag carries the rest.
    //
    // The floor is a second line of defence rather than a preference: a
    // transient layout size reported mid-construction or mid-teardown is never
    // a window anyone sat in front of, and this is state that persists.
    if (! isFullScreen())
    {
        // A last floor on top of `ready`, because this is state that persists:
        // a rectangle too small to have been dragged by anyone is not reported
        // at all rather than reported and filtered later.
        if (getWidth() < Tone3000WindowState::Bounds::minimumSize
            || getHeight() < Tone3000WindowState::Bounds::minimumSize)
            return;

        restoredBounds = getBounds();
    }

    if (callbacks.onPlaceChanged)
        callbacks.onPlaceChanged (getCurrentUrl(), getPlacement());
    else
        Tone3000WindowState::trace ("place reported with nobody listening");
}

void Tone3000BrowserWindow::closeButtonPressed()
{
    // Reported, never acted on: the owner decides whether a close hides this
    // window or destroys it.
    //
    // NOT consumed. It used to be — `std::exchange(…, nullptr)` — because the
    // owner always destroyed the window, so a second close could not happen.
    // Now that closing only hides it, consuming the callback meant the *second*
    // close reached nobody: the window stayed on screen, ignoring its own close
    // button, until the app was restarted.
    if (callbacks.onClosed)
        callbacks.onClosed();
}

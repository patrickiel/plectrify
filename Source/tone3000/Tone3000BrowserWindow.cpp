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
/** How far down the page the reader is.

    `scrollingElement` first, `window.scrollY` second: which of the two answers
    depends on how the document is laid out, and asking for both costs nothing.
    This is the entirety of what Plectrify ever asks TONE3000's pages — one
    number, read, never anything written back except a scroll position the user
    themselves left. Nothing is inspected, collected or sent anywhere. */
const char* const readScrollScript =
    "(() => { const e = document.scrollingElement; "
    "return Math.round(e ? e.scrollTop : (window.scrollY || 0)); })()";

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
                                              const juce::String& redirectUri,
                                              Tone3000WindowState::Bounds saved,
                                              Callbacks callbacksIn)
    : juce::DocumentWindow ("TONE3000",
                            juce::Colours::black,
                            juce::DocumentWindow::closeButton | juce::DocumentWindow::maximiseButton
                                | juce::DocumentWindow::minimiseButton),
      callbacks (std::move (callbacksIn))
{
   #if JUCE_WINDOWS
    // Its own user-data folder. Two WebView2 environments in one process must
    // agree on their options to share one, and this window's differ from the
    // UI's — a folder each is the only lock-free answer. The name keeps it
    // inside the dev loop's orphan-killer glob (see scripts/windows.ts).
    const auto dataFolder = plectrify::appDataDir().getChildFile ("WebView2-Tone3000");
    dataFolder.createDirectory();
   #endif

    auto options = juce::WebBrowserComponent::Options{}
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

    browser = std::make_unique<Browser> (redirectUri,
                                         std::move (callbacks.onCallback),
                                         [this] { reportPlace(); },
                                         options);

    setContentNonOwned (browser.get(), false);
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

void Tone3000BrowserWindow::show (const juce::String& reloadIfBlank)
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

    if (browser->getCurrentUrl().isEmpty() && reloadIfBlank.isNotEmpty())
        browser->goToURL (reloadIfBlank);
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
                                     + readScrollScript,
                                     [this] (juce::WebBrowserComponent::EvaluationResult result)
                                     {
                                         if (const auto* value = result.getResult())
                                             if ((int) *value >= pendingScrollY)
                                                 scrollAttemptsLeft = 0;
                                     });
        return;
    }

    browser->evaluateJavascript (readScrollScript,
                                 [this] (juce::WebBrowserComponent::EvaluationResult result)
                                 {
                                     const auto* value = result.getResult();

                                     if (value == nullptr || tearingDown)
                                         return;

                                     const auto scrollY = (int) *value;

                                     if (scrollY == lastScrollY)
                                         return;

                                     lastScrollY = scrollY;

                                     if (callbacks.onScrolled)
                                         callbacks.onScrolled (scrollY);
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

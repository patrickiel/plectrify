#include <JuceHeader.h>
#include <PlectrifyAssets.h>
#include "AppPaths.h"
#include "AppReset.h"
#include "CrashReporter.h"
#include "MainComponent.h"
#include "WindowLookAndFeel.h"

/**
    Standalone entry point for the Plectrify guitar-rig host. Creates a single
    resizable window containing the whole app.
*/
class PlectrifyApplication : public juce::JUCEApplication
{
public:
    PlectrifyApplication() = default;

    const juce::String getApplicationName() override    { return "Plectrify"; }
    const juce::String getApplicationVersion() override { return JUCE_APPLICATION_VERSION_STRING; }
    // One instance, except for the one a reset relaunches: that process starts
    // while the instance that scheduled the reset is still quitting, and the
    // stock check would hand it that instance's window and exit. It waits for
    // the other to be gone instead — see waitForResettingInstance().
    bool moreThanOneInstanceAllowed() override          { return isRelaunchAfterReset(); }

    void initialise (const juce::String&) override
    {
        // Log and crash handler first, so anything startup does wrong is on
        // record. One rotating file: a crashing launch loop must not fill the
        // user's disk with logs.
        logger.reset (juce::FileLogger::createDefaultAppLogger (
            "Plectrify", "plectrify.log",
            "Plectrify " + getApplicationVersion() + " starting"));
        juce::Logger::setCurrentLogger (logger.get());
        plectrify::installCrashHandler();

        if (isRelaunchAfterReset() && ! waitForResettingInstance())
        {
            // The old instance is still up after half a minute (or the lock
            // could not be taken at all). Clearing the data under a running
            // app is exactly what the reset is scheduled to avoid — and so is
            // leaving the marker armed: the user, seeing nothing happen, keeps
            // playing in that instance and saves work the snapshot predates,
            // which the next ordinary launch would then wipe. So the reset is
            // called off, not deferred; the snapshot stays where the Reset
            // card can find it and the user asks again.
            juce::Logger::writeToLog ("Reset: the previous instance did not quit; the reset is cancelled");
            plectrify::reset::cancel (plectrify::appDataDir());
            quit();
            return;
        }

        // Before anything reads the data root — the device setup, the plugin
        // cache, the page's settings — so this launch starts as a fresh
        // installation would (AppReset.h). A no-op on every launch that follows
        // no reset.
        const auto reset = plectrify::reset::performIfScheduled (plectrify::appDataDir(), 20, 250);
        if (reset.ran)
            juce::Logger::writeToLog (reset.leftBehind.isEmpty()
                                          ? juce::String ("Reset: data root cleared")
                                          : "Reset: could not remove " + reset.leftBehind.joinIntoString (", "));

        // What it could not remove is the page's to show, not just the log's:
        // the TONE3000 profile is the likeliest leftover, and an app that
        // looks fresh while their site still knows the account is a reset that
        // lied. The window hands it to the shell, which reports it when the
        // page asks for its backup state.
        mainWindow = std::make_unique<MainWindow> (getApplicationName(), reset.leftBehind);
    }

    void shutdown() override
    {
        mainWindow = nullptr;

        juce::Logger::writeToLog ("Plectrify shut down cleanly");
        juce::Logger::setCurrentLogger (nullptr);
        logger = nullptr;
    }

    void systemRequestedQuit() override
    {
        quit();
    }

    // Top-level document window that owns the MainComponent.
    class MainWindow : public juce::DocumentWindow
    {
    public:
        MainWindow (juce::String name, const juce::StringArray& resetLeftBehind)
            : juce::DocumentWindow (name,
                                    juce::Colour (0xff020305),
                                    juce::DocumentWindow::allButtons)
        {
            // macOS draws its own window: title bar, traffic lights, rounded
            // corners, the system shadow, Spaces, tabbing and real full screen.
            // A borderless window forfeits all of it — AppKit will not even
            // full-screen one, which left the maximise control dead — so the
            // custom chrome is Windows-only. WindowLookAndFeel is still set on
            // both, but on macOS only its frame colour is ever consulted; the
            // title bar it can draw is never asked for.
            //
            // Linux takes the native decoration too: the window manager's
            // frame is what tiling, snapping, workspaces and Wayland's
            // server-side decorations all hang off, and a borderless X11
            // window opts out of every one of them.
           #if JUCE_MAC || JUCE_LINUX
            setUsingNativeTitleBar (true);
           #else
            setUsingNativeTitleBar (false);
           #endif

            setLookAndFeel (&windowLookAndFeel);

            // Both no-op under a native title bar.
            setTitleBarHeight (34);
            setTitleBarTextCentred (false);

            const auto appIcon = juce::ImageCache::getFromMemory (
                PlectrifyAssets::PlectrifyIconSmall_png,
                PlectrifyAssets::PlectrifyIconSmall_pngSize);
            if (appIcon.isValid())
                setIcon (appIcon);

            auto* content = new MainComponent();
            content->reportResetLeftovers (resetLeftBehind);
            content->onWindowThemeChanged = [this] (bool light) { setChromeTheme (light); };
            setContentOwned (content, true);

            setResizable (true, false);
            setResizeLimits (760, 480, 32768, 32768);
            centreWithSize (getWidth(), getHeight());
            setVisible (true);
        }

        ~MainWindow() override
        {
            setLookAndFeel (nullptr);
        }

        void closeButtonPressed() override
        {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }

        void activeWindowStatusChanged() override
        {
            juce::DocumentWindow::activeWindowStatusChanged();

            // DocumentWindow disables custom title-bar buttons when JUCE
            // considers the window inactive. WebView2 owns a native child
            // window and may briefly move focus there after startup, which
            // made all three controls look muted and suppressed their hover
            // feedback. Keep standard window controls available; the custom
            // title-bar palette is intentionally independent of child focus.
            // No-ops on macOS, where the buttons are AppKit's and absent here.
            if (auto* button = getMinimiseButton())
                button->setEnabled (true);

            if (auto* button = getMaximiseButton())
                button->setEnabled (true);

            if (auto* button = getCloseButton())
                button->setEnabled (true);
        }

    private:
        // Repaints the JUCE-drawn chrome in the UI's colour theme. The window
        // controls are children of this window, so one repaint covers them.
        // On macOS this leaves only the frame colour behind the web view: the
        // title bar there is AppKit's and follows the system appearance.
        void setChromeTheme (bool light)
        {
            if (light == windowLookAndFeel.isUsingLightTheme())
                return;

            windowLookAndFeel.setLightTheme (light);
            setBackgroundColour (windowLookAndFeel.getWindowBackgroundColour());
            repaint();
        }

        WindowLookAndFeel windowLookAndFeel;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
    };

private:
    static bool isRelaunchAfterReset()
    {
        return getCommandLineParameterArray().contains (plectrify::reset::relaunchFlag);
    }

    /** Blocks until the instance that scheduled the reset has exited, by taking
        the very lock JUCE's single-instance check holds for a running app
        ("juceAppLock_" + the app name, juce_ApplicationBase.cpp). That lock is
        released when the old process finishes shutting down, which is the
        moment its last write to the data root is behind it. Kept for this
        process's lifetime, so a launch after this one still finds an instance
        running and steps aside exactly as it would for any other. */
    bool waitForResettingInstance()
    {
        instanceLock = std::make_unique<juce::InterProcessLock> ("juceAppLock_" + getApplicationName());
        return instanceLock->enter (30000);
    }

    std::unique_ptr<juce::FileLogger> logger;
    // Only ever set on a relaunch after a reset; see waitForResettingInstance().
    std::unique_ptr<juce::InterProcessLock> instanceLock;
    std::unique_ptr<MainWindow> mainWindow;
};

START_JUCE_APPLICATION (PlectrifyApplication)

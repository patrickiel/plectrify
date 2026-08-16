#include <JuceHeader.h>
#include <PlectrifyAssets.h>
#include "AppPaths.h"
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
    bool moreThanOneInstanceAllowed() override          { return false; }

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

        mainWindow = std::make_unique<MainWindow> (getApplicationName());
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
        explicit MainWindow (juce::String name)
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
           #if JUCE_MAC
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
    std::unique_ptr<juce::FileLogger> logger;
    std::unique_ptr<MainWindow> mainWindow;
};

START_JUCE_APPLICATION (PlectrifyApplication)

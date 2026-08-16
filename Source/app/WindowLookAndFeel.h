#pragma once

#include <JuceHeader.h>

/**
    Draws the main Plectrify window's borderless chrome. The class is owned by the
    main window and is only used on the message thread, like the JUCE components
    whose title bar and window controls it creates.

    That chrome is Windows-only: macOS uses its native title bar, so nothing
    below is called there except getWindowBackgroundColour(), which still paints
    the frame behind the web view.

    The chrome follows the web UI's colour theme: the UI pushes `setWindowTheme`
    over the bridge whenever the user switches, and the window forwards it to
    setLightTheme(). Both palettes mirror the CSS tokens in ui/src/app.css.
*/
class WindowLookAndFeel final : public juce::LookAndFeel_V4
{
public:
    WindowLookAndFeel() = default;

    /** Paints the chrome in the light palette rather than the dark one. Message
        thread only; the caller repaints the window afterwards. */
    void setLightTheme (bool shouldUseLightTheme);

    bool isUsingLightTheme() const noexcept { return isLightTheme; }

    /** The window's own background colour for the current palette, so the frame
        behind the web view matches the title bar. */
    juce::Colour getWindowBackgroundColour() const;

    void drawDocumentWindowTitleBar (juce::DocumentWindow& window,
                                     juce::Graphics& graphics,
                                     int width,
                                     int height,
                                     int titleSpaceX,
                                     int titleSpaceWidth,
                                     const juce::Image* icon,
                                     bool drawTitleTextOnLeft) override;

    juce::Button* createDocumentWindowButton (int buttonType) override;

    void positionDocumentWindowButtons (juce::DocumentWindow& window,
                                        int titleBarX,
                                        int titleBarY,
                                        int titleBarWidth,
                                        int titleBarHeight,
                                        juce::Button* minimiseButton,
                                        juce::Button* maximiseButton,
                                        juce::Button* closeButton,
                                        bool positionTitleBarButtonsOnLeft) override;

    void drawResizableWindowBorder (juce::Graphics& graphics,
                                    int width,
                                    int height,
                                    const juce::BorderSize<int>& border,
                                    juce::ResizableWindow& window) override;

private:
    bool isLightTheme = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WindowLookAndFeel)
};

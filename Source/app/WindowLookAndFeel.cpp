#include "WindowLookAndFeel.h"

#include "PlectrifyAssets.h"

namespace
{
    /** The wordmark face — the same Chakra Petch 600 the website's logo is set
        in, so the bar's "Plectrify" and the site's are one mark. Falls back to
        the default bold sans if the embedded TTF ever fails to parse, which
        keeps the bar legible rather than blank. */
    juce::Font titleBarFont()
    {
        static const juce::Typeface::Ptr wordmark = juce::Typeface::createSystemTypefaceFor (
            PlectrifyAssets::ChakraPetchSemiBold_ttf, PlectrifyAssets::ChakraPetchSemiBold_ttfSize);

        if (wordmark != nullptr)
            return juce::Font (juce::FontOptions {}.withTypeface (wordmark).withHeight (19.0f));

        return juce::Font (juce::FontOptions { 18.0f, juce::Font::bold });
    }

    /** One theme's worth of chrome colours. The values mirror the CSS tokens in
        ui/src/app.css (--color-space/-panel/-accent/-danger/-muted/-ink) so the
        title bar reads as the same surface as the page beneath it. */
    struct Palette
    {
        juce::uint32 space;
        juce::uint32 panel;
        juce::uint32 accent;
        juce::uint32 danger;
        juce::uint32 muted;
        juce::uint32 ink;
    };

    constexpr Palette darkPalette  { 0xff020305, 0xff0f1219, 0xff00ffcc, 0xffff2a55, 0xff9ba6b5, 0xffffffff };
    // Light is not an inversion: the neon accent drops in lightness (#00ffcc is
    // 1.1:1 on white). The bar sits a step *below* the page's #eceff4 rather
    // than above it — white-on-white left the chrome with no edge, so here the
    // title bar is the darker surface the page floats on.
    constexpr Palette lightPalette { 0xffd3dae4, 0xfff0f3f7, 0xff00705f, 0xffc31435, 0xff4a5566, 0xff0d1626 };

    constexpr const Palette& paletteFor (bool isLight)
    {
        return isLight ? lightPalette : darkPalette;
    }

    class WindowControlButton final : public juce::Button
    {
    public:
        WindowControlButton (int type, const WindowLookAndFeel& owner)
            : juce::Button (buttonName (type)), buttonType (type), lookAndFeel (owner)
        {
        }

        void paintButton (juce::Graphics& graphics,
                          bool shouldDrawButtonAsHighlighted,
                          bool shouldDrawButtonAsDown) override
        {
            const auto& palette = paletteFor (lookAndFeel.isUsingLightTheme());
            const bool isClose = buttonType == juce::DocumentWindow::closeButton;
            const auto actionColour = juce::Colour (isClose ? palette.danger : palette.accent);

            if (shouldDrawButtonAsHighlighted || shouldDrawButtonAsDown)
            {
                const auto alpha = shouldDrawButtonAsDown ? 0.28f : 0.16f;
                graphics.fillAll (actionColour.withAlpha (alpha));
            }

            auto glyphColour = isEnabled() ? juce::Colour (palette.ink).withAlpha (0.82f)
                                           : juce::Colour (palette.muted).withAlpha (0.42f);
            if (shouldDrawButtonAsHighlighted)
                glyphColour = actionColour;

            graphics.setColour (glyphColour);

            const auto bounds = getLocalBounds().toFloat();
            const auto centre = bounds.getCentre();
            constexpr float glyphSize = 12.0f;
            constexpr float lineWidth = 1.35f;
            const auto left = centre.x - glyphSize * 0.5f;
            const auto top = centre.y - glyphSize * 0.5f;

            if (buttonType == juce::DocumentWindow::minimiseButton)
            {
                graphics.drawLine (left, centre.y + 3.5f, left + glyphSize, centre.y + 3.5f, lineWidth);
                return;
            }

            if (buttonType == juce::DocumentWindow::maximiseButton)
            {
                if (getToggleState())
                {
                    graphics.drawLine (left + 3.0f, top, left + 12.0f, top, lineWidth);
                    graphics.drawLine (left + 12.0f, top, left + 12.0f, top + 9.0f, lineWidth);
                    graphics.drawRect (juce::Rectangle<float> (left, top + 3.0f, 9.0f, 9.0f), lineWidth);
                }
                else
                {
                    graphics.drawRect (juce::Rectangle<float> (left, top, glyphSize, glyphSize), lineWidth);
                }
                return;
            }

            graphics.drawLine (left + 1.0f, top + 1.0f,
                               left + glyphSize - 1.0f, top + glyphSize - 1.0f, lineWidth);
            graphics.drawLine (left + glyphSize - 1.0f, top + 1.0f,
                               left + 1.0f, top + glyphSize - 1.0f, lineWidth);
        }

    private:
        static juce::String buttonName (int type)
        {
            if (type == juce::DocumentWindow::minimiseButton) return "Minimise";
            if (type == juce::DocumentWindow::maximiseButton) return "Maximise";
            return "Close";
        }

        const int buttonType;
        const WindowLookAndFeel& lookAndFeel;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WindowControlButton)
    };
}

void WindowLookAndFeel::drawDocumentWindowTitleBar (juce::DocumentWindow& window,
                                                     juce::Graphics& graphics,
                                                     int width,
                                                     int height,
                                                     int titleSpaceX,
                                                     int titleSpaceWidth,
                                                     const juce::Image* icon,
                                                     bool)
{
    if (width <= 0 || height <= 0)
        return;

    const auto& palette = paletteFor (isLightTheme);

    juce::ColourGradient background (juce::Colour (palette.panel).brighter (0.035f),
                                       0.0f, 0.0f,
                                       juce::Colour (palette.space),
                                       0.0f, (float) height,
                                       false);
    graphics.setGradientFill (background);
    graphics.fillAll();

    graphics.setColour (juce::Colour (palette.accent).withAlpha (0.34f));
    graphics.fillRect (0, height - 1, width, 1);

    const auto titleFont = titleBarFont();
    const auto title = window.getName();
    const auto titleWidth = juce::GlyphArrangement::getStringWidthInt (titleFont, title);
    const auto hasIcon = icon != nullptr && icon->isValid();
    // Deliberately well inside the bar: the icon is a mark next to the name,
    // not the bar's subject, so the wordmark stays the larger of the two.
    // 16 rather than a snugger fit because the source art is 64 px square: at
    // 100 % display scaling that is an exact 4:1 reduction, where an arbitrary
    // size lands the 64-px grid between output pixels and smears the mark. On a
    // scaled display the context transform makes it 24/32 px, which has enough
    // resolution for the fit not to matter.
    const auto iconSize = juce::jmax (0, juce::jmin (16, height - 12));
    const auto iconX = juce::jmax (10, titleSpaceX);

    if (hasIcon && iconSize > 0)
    {
        graphics.setOpacity (1.0f);
        // The default (low) quality is a plain point sample — visibly ragged on
        // a 4:1 reduction of detailed art.
        graphics.setImageResamplingQuality (juce::Graphics::highResamplingQuality);
        graphics.drawImageWithin (*icon, iconX, (height - iconSize) / 2,
                                  iconSize, iconSize,
                                  juce::RectanglePlacement::centred);
    }

    const auto textX = juce::jmax (16, hasIcon ? iconX + iconSize + 9 : titleSpaceX);
    const auto availableWidth = juce::jmax (0, titleSpaceX + titleSpaceWidth - textX);
    const auto textBounds = juce::Rectangle<int> (textX, 0, availableWidth, height);

    graphics.setFont (titleFont);
    graphics.setColour (juce::Colour (palette.ink));
    graphics.drawFittedText (title,
                             textBounds.withWidth (juce::jmin (availableWidth, titleWidth + 2)),
                             juce::Justification::centredLeft, 1);
}

void WindowLookAndFeel::setLightTheme (bool shouldUseLightTheme)
{
    isLightTheme = shouldUseLightTheme;
}

juce::Colour WindowLookAndFeel::getWindowBackgroundColour() const
{
    return juce::Colour (paletteFor (isLightTheme).space);
}

juce::Button* WindowLookAndFeel::createDocumentWindowButton (int buttonType)
{
    return new WindowControlButton (buttonType, *this);
}

void WindowLookAndFeel::positionDocumentWindowButtons (juce::DocumentWindow&,
                                                        int titleBarX,
                                                        int titleBarY,
                                                        int titleBarWidth,
                                                        int titleBarHeight,
                                                        juce::Button* minimiseButton,
                                                        juce::Button* maximiseButton,
                                                        juce::Button* closeButton,
                                                        bool positionTitleBarButtonsOnLeft)
{
    constexpr int buttonWidth = 46;
    auto x = positionTitleBarButtonsOnLeft ? titleBarX
                                           : titleBarX + titleBarWidth - buttonWidth;
    const auto step = positionTitleBarButtonsOnLeft ? buttonWidth : -buttonWidth;

    const auto place = [&] (juce::Button* button)
    {
        if (button == nullptr)
            return;

        button->setBounds (x, titleBarY, buttonWidth, titleBarHeight);
        x += step;
    };

    place (closeButton);
    place (maximiseButton);
    place (minimiseButton);
}

void WindowLookAndFeel::drawResizableWindowBorder (juce::Graphics& graphics,
                                                    int width,
                                                    int height,
                                                    const juce::BorderSize<int>&,
                                                    juce::ResizableWindow&)
{
    graphics.setColour (juce::Colour (paletteFor (isLightTheme).accent).withAlpha (0.58f));
    graphics.drawRect (0, 0, width, height, 1);
}

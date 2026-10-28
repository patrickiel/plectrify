#include "NamPluginEditor.h"

namespace
{
constexpr int slotHeight = 32;
constexpr int margin = 10;
} // namespace

NamPluginEditor::NamPluginEditor (NamPluginProcessor& p)
    : AudioProcessorEditor (p), processor (p), parameters (p)
{
    setUpSlot (modelSlot, "Model", "*.nam", true);
    setUpSlot (irSlot, "IR", "*.wav", false);

    status.setColour (juce::Label::textColourId, juce::Colours::orange);
    addAndMakeVisible (status);
    addAndMakeVisible (parameters);

    setResizable (true, true);
    setResizeLimits (420, 360, 1200, 1400);
    setSize (520, 620);

    timerCallback();
    startTimerHz (4);
}

NamPluginEditor::~NamPluginEditor()
{
    stopTimer();
}

void NamPluginEditor::setUpSlot (FileSlot& slot, const juce::String& title,
                                 const juce::String& pattern, bool isModel)
{
    slot.title.setText (title, juce::dontSendNotification);
    slot.title.setFont (juce::FontOptions (15.0f, juce::Font::bold));
    slot.file.setMinimumHorizontalScale (0.6f);

    slot.choose.onClick = [this, pattern, isModel, title]
    {
        chooser = std::make_unique<juce::FileChooser> ("Choose " + title, juce::File(), pattern);
        chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                              [this, isModel] (const juce::FileChooser& fc)
                              {
                                  const auto file = fc.getResult();
                                  if (file == juce::File())
                                      return;

                                  const auto error = isModel ? processor.loadModel (file)
                                                             : processor.loadImpulseResponse (file);
                                  status.setText (error, juce::dontSendNotification);
                                  timerCallback();
                              });
    };

    slot.clear.onClick = [this, isModel]
    {
        if (isModel)
            processor.clearModel();
        else
            processor.clearImpulseResponse();
        status.setText ({}, juce::dontSendNotification);
        timerCallback();
    };

    for (auto* c : std::initializer_list<juce::Component*> { &slot.title, &slot.file, &slot.choose, &slot.clear })
        addAndMakeVisible (c);
}

void NamPluginEditor::showSlot (FileSlot& slot, const juce::String& path)
{
    const auto text = path.isEmpty() ? juce::String ("(none)") : juce::File (path).getFileName();
    if (slot.file.getText() != text)
    {
        slot.file.setText (text, juce::dontSendNotification);
        slot.file.setTooltip (path);
    }
    slot.clear.setEnabled (path.isNotEmpty());
}

void NamPluginEditor::timerCallback()
{
    showSlot (modelSlot, processor.getModelPath());
    showSlot (irSlot, processor.getImpulseResponsePath());
}

void NamPluginEditor::paint (juce::Graphics& g)
{
    g.fillAll (getLookAndFeel().findColour (juce::ResizableWindow::backgroundColourId));
}

void NamPluginEditor::resized()
{
    auto area = getLocalBounds().reduced (margin);

    for (auto* slot : { &modelSlot, &irSlot })
    {
        auto row = area.removeFromTop (slotHeight);
        slot->title.setBounds (row.removeFromLeft (60));
        slot->clear.setBounds (row.removeFromRight (70).reduced (2));
        slot->choose.setBounds (row.removeFromRight (80).reduced (2));
        slot->file.setBounds (row);
        area.removeFromTop (4);
    }

    status.setBounds (area.removeFromTop (22));
    area.removeFromTop (margin);
    parameters.setBounds (area);
}

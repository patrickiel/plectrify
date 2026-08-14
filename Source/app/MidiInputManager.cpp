#include "MidiInputManager.h"

MidiInputManager::MidiInputManager (std::function<void (const juce::var&)> onEventsIn,
                                    std::function<void (const juce::StringArray&)> onDevicesChangedIn)
    : onEvents (std::move (onEventsIn)),
      onDevicesChanged (std::move (onDevicesChangedIn))
{
    refreshDevices();
    startTimer (2000);
}

MidiInputManager::~MidiInputManager()
{
    stopTimer();
    *alive = false;

    // stop() blocks until the device's callback thread is out of
    // handleIncomingMidiMessage, so after this loop nothing touches `pending`.
    for (auto& input : inputs)
        input->stop();

    inputs.clear();
}

juce::StringArray MidiInputManager::openDeviceNames() const
{
    juce::StringArray names;

    for (auto& input : inputs)
        names.add (input->getName());

    return names;
}

void MidiInputManager::timerCallback()
{
    refreshDevices();
}

void MidiInputManager::refreshDevices()
{
    const auto available = juce::MidiInput::getAvailableDevices();
    bool changed = false;

    // Drop inputs whose device has vanished.
    for (int i = (int) inputs.size(); --i >= 0;)
    {
        const auto identifier = inputs[(size_t) i]->getIdentifier();
        const bool stillPresent = std::any_of (available.begin(), available.end(),
                                               [&] (const juce::MidiDeviceInfo& d)
                                               { return d.identifier == identifier; });
        if (! stillPresent)
        {
            inputs[(size_t) i]->stop();
            inputs.erase (inputs.begin() + i);
            changed = true;
        }
    }

    // Open anything new.
    for (const auto& device : available)
    {
        const bool alreadyOpen = std::any_of (inputs.begin(), inputs.end(),
                                              [&] (const std::unique_ptr<juce::MidiInput>& input)
                                              { return input->getIdentifier() == device.identifier; });
        if (alreadyOpen)
            continue;

        if (auto input = juce::MidiInput::openDevice (device.identifier, this))
        {
            input->start();
            inputs.push_back (std::move (input));
            changed = true;
        }
    }

    if (changed && onDevicesChanged != nullptr)
        onDevicesChanged (openDeviceNames());
}

void MidiInputManager::handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& message)
{
    PendingEvent event;

    if (message.isController())
        event = { "cc", message.getChannel(), message.getControllerNumber(), message.getControllerValue() };
    else if (message.isProgramChange())
        event = { "pc", message.getChannel(), message.getProgramChangeNumber(), 0 };
    else if (message.isNoteOn()) // velocity > 0 only; note-offs never trigger
        event = { "note", message.getChannel(), message.getNoteNumber(), message.getVelocity() };
    else
        return;

    bool scheduleFlush = false;

    {
        const juce::ScopedLock lock (pendingLock);

        // A CC replaces the newest pending value for the same controller, but
        // only while both values sit on the same side of the UI's press
        // threshold (MIDI_PRESS_THRESHOLD in ui/src/lib/engine/midi.ts): a
        // swept pedal still coalesces to its latest position, capping the
        // batch, while a quick press+release tap keeps both edges — merging
        // 127 then 0 into a lone 0 would swallow the press when the message
        // thread is too busy to flush between the two.
        constexpr int pressThreshold = 64;

        if (event.type[0] == 'c')
        {
            const auto newest = std::find_if (pending.rbegin(), pending.rend(),
                                              [&] (const PendingEvent& p)
                                              {
                                                  return p.type[0] == 'c'
                                                      && p.channel == event.channel
                                                      && p.number == event.number;
                                              });
            if (newest != pending.rend()
                && (newest->value >= pressThreshold) == (event.value >= pressThreshold))
            {
                newest->value = event.value;
            }
            else
            {
                pending.push_back (event);
            }
        }
        else
        {
            pending.push_back (event);
        }

        if (! flushScheduled)
        {
            flushScheduled = true;
            scheduleFlush = true;
        }
    }

    if (scheduleFlush)
    {
        juce::MessageManager::callAsync ([this, aliveToken = std::weak_ptr<bool> (alive)]
        {
            if (auto locked = aliveToken.lock(); locked != nullptr && *locked)
                flushPending();
        });
    }
}

void MidiInputManager::flushPending()
{
    std::vector<PendingEvent> batch;

    {
        const juce::ScopedLock lock (pendingLock);
        batch.swap (pending);
        flushScheduled = false;
    }

    if (batch.empty() || onEvents == nullptr)
        return;

    juce::Array<juce::var> events;

    for (const auto& event : batch)
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("type", juce::String (event.type));
        object->setProperty ("channel", event.channel);
        object->setProperty ("number", event.number);
        object->setProperty ("value", event.value);
        events.add (juce::var (object));
    }

    onEvents (juce::var (std::move (events)));
}

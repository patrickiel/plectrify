#include "LooperSessionStore.h"

void LooperSessionStore::saveAsync (juce::AudioBuffer<float>&& audio, int lengthSamples,
                                    double sampleRate, std::function<void (SaveResult)> onDone)
{
    // shared_ptr keeps the lambda copyable (std::function) without ever
    // copying a minute of audio.
    auto buffer = std::make_shared<juce::AudioBuffer<float>> (std::move (audio));
    const auto timestamp = juce::Time::getCurrentTime();

    pool.addJob ([dir = directory, buffer, lengthSamples, sampleRate, timestamp,
                  onDone = std::move (onDone)]
    {
        auto result = writeWav (dir, *buffer, lengthSamples, sampleRate, timestamp);
        juce::MessageManager::callAsync ([onDone, result = std::move (result)] { onDone (result); });
    });
}

void LooperSessionStore::loadAsync (juce::File file, double targetSampleRate, int maxSamples,
                                    std::function<void (LoadResult)> onDone)
{
    pool.addJob ([file = std::move (file), targetSampleRate, maxSamples,
                  onDone = std::move (onDone)]
    {
        auto result = std::make_shared<LoadResult> (readWav (file, targetSampleRate, maxSamples));
        juce::MessageManager::callAsync ([onDone, result] { onDone (std::move (*result)); });
    });
}

LooperSessionStore::SaveResult LooperSessionStore::writeWav (const juce::File& directory,
                                                             const juce::AudioBuffer<float>& audio,
                                                             int lengthSamples, double sampleRate,
                                                             juce::Time timestamp)
{
    SaveResult result;
    if (lengthSamples <= 0 || lengthSamples > audio.getNumSamples() || sampleRate <= 0.0)
        return result;

    directory.createDirectory();
    const auto target = directory.getNonexistentChildFile (
        timestamp.formatted ("session-%Y%m%d-%H%M%S"), ".wav");

    // Temp file + rename, the same crash-safety as handleWriteFile: a session
    // either exists whole or not at all.
    juce::TemporaryFile temporary (target);
    {
        std::unique_ptr<juce::OutputStream> stream {
            temporary.getFile().createOutputStream()
        };
        if (stream == nullptr)
            return result;

        juce::WavAudioFormat wav;
        const auto options = juce::AudioFormatWriterOptions {}
                                 .withSampleRate (sampleRate)
                                 .withNumChannels (2)
                                 .withBitsPerSample (32);
        auto writer = wav.createWriterFor (stream, options);
        if (writer == nullptr)
            return result;

        if (! writer->writeFromAudioSampleBuffer (audio, 0, lengthSamples))
            return result;
    }
    if (! temporary.overwriteTargetFileWithTemporary())
        return result;

    result.ok = true;
    result.fileName = target.getFileName();
    result.durationSeconds = lengthSamples / sampleRate;
    result.sampleRate = sampleRate;
    result.timestampMs = timestamp.toMilliseconds();
    return result;
}

LooperSessionStore::LoadResult LooperSessionStore::readWav (const juce::File& file,
                                                            double targetSampleRate, int maxSamples)
{
    LoadResult result;
    if (targetSampleRate <= 0.0 || maxSamples <= 0 || ! file.existsAsFile())
        return result;

    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatReader> reader (
        wav.createReaderFor (new juce::FileInputStream (file), true));
    if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0)
        return result;

    // Never read more source material than can fit the loop after resampling.
    const double ratio = reader->sampleRate / targetSampleRate;
    const auto sourceCap = (juce::int64) std::ceil (maxSamples * ratio) + 8;
    const int sourceLength = (int) juce::jmin (reader->lengthInSamples, sourceCap);

    // A few padding zeros past the end keep the interpolator's read-ahead in
    // bounds on the last output samples.
    juce::AudioBuffer<float> source (2, sourceLength + 8);
    source.clear();
    // useRightChan=true duplicates a mono file onto both channels.
    reader->read (&source, 0, sourceLength, 0, true, true);

    result.buffer.setSize (2, maxSamples);
    result.buffer.clear();

    if (std::abs (ratio - 1.0) < 1.0e-9)
    {
        const int length = juce::jmin (sourceLength, maxSamples);
        for (int ch = 0; ch < 2; ++ch)
            result.buffer.copyFrom (ch, 0, source, ch, 0, length);
        result.lengthSamples = length;
    }
    else
    {
        const int outLength = juce::jmin (maxSamples, (int) std::floor (sourceLength / ratio));
        for (int ch = 0; ch < 2; ++ch)
        {
            juce::LagrangeInterpolator interpolator;
            interpolator.process (ratio, source.getReadPointer (ch),
                                  result.buffer.getWritePointer (ch), outLength);
        }
        result.lengthSamples = outLength;
    }

    result.ok = result.lengthSamples > 0;
    return result;
}

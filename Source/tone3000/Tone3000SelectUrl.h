#pragma once

#include <JuceHeader.h>

/**
    Reading and rebuilding TONE3000's Select-flow URLs, so the window can reopen
    on the page the user was actually reading.

    Their browse UI lives under `/api/v1/select`, and it does put the user's
    place in the URL:

        /api/v1/select?authorization_id=X                       the catalogue
        /api/v1/select?creators=akka5&authorization_id=X        a filtered list
        /api/v1/select/tones/02-vox-ac306-70408?authorization_id=X   one tone

    The one part that cannot be reused is `authorization_id`: it identifies a
    single sign-in attempt, and picking a tone spends it. Reopening a saved URL
    whole therefore lands on their "your session has expired" page every time —
    which is exactly what it did.

    So a *place* here is the URL with that one parameter taken out: path plus
    whatever filters were on it. It is not a credential and not a session, which
    is why it can sit in plain `state.json` next to the window's bounds. On the
    next open the flow is started fresh as always, and once it has landed and
    handed out a new authorization the place is re-attached to it —
    `urlForPlace` — putting the user back where they were inside a flow that
    actually works.

    Pure string rules, so the parts that matter — that only their own Select
    pages are ever recognised or rebuilt, and that a stale authorization can
    never be carried forward — are covered without a socket or a window.
*/
namespace Tone3000SelectUrl
{
/** Is this one of TONE3000's Select-flow pages, on the API host we were built
    against? Anything else — their marketing site, a link a tone's description
    points at, our own redirect URI — is not a place to reopen on. */
bool isSelectPage (const juce::String& url, const juce::String& apiBase);

/** The part worth remembering: path and query with `authorization_id` removed,
    e.g. "/api/v1/select/tones/02-vox-ac306-70408" or
    "/api/v1/select?creators=akka5". Empty for any URL that is not a Select
    page. */
juce::String placeOf (const juce::String& url, const juce::String& apiBase);

/** The authorization currently in force, read from a live Select URL. Empty if
    there is none — which is the flow not having landed yet, and a reason to
    wait rather than to rebuild anything. */
juce::String authorizationIdOf (const juce::String& url);

/** A remembered place inside a live flow. Empty unless both halves are
    present, so a caller cannot accidentally build a URL that drops the user
    somewhere unauthorised. */
juce::String urlForPlace (const juce::String& apiBase,
                          const juce::String& place,
                          const juce::String& authorizationId);
} // namespace Tone3000SelectUrl

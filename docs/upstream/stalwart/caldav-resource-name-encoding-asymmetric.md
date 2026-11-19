---
type: upstream
title: A resource name is percent-encoded in some hrefs and not others
description: Stalwart percent-encodes the account segment of a href but not the resource segment of that same href. Up to 0.16.27 it also resolved the resource segment by exact string match, so `@` and `%40` named two objects and a client that normalized the href it was given lost the object (the Apple Calendar failure). 1.0.0 fixed resolution, so that failure is gone; the mixed encoding within one href remains. Our resource names are generated free of such characters, which is what RFC 4791 §5.3.2 asks for anyway.
status: open
observed: 0.16.22
owner: dominik
tags: [stalwart, caldav, calendar, encoding]
---

# A resource name is percent-encoded in some hrefs and not others

> **Half fixed in 1.0.0** (source read and live test, 2026-10-28). The request
> URI is now canonicalised before lookup (`crates/dav/src/request.rs:634` →
> `canonical_dav_uri` in `crates/dav/src/common/uri.rs:237-249` →
> `canonical_calcard_uri`, which percent-decodes the resource segment and
> re-encodes it without escaping `@`), and the path index is built with the
> same function. So `@` and `%40` resolve to one resource: a second `PUT` under
> the other spelling answers `412`, and a `MOVE` addressed by the normalized
> spelling moves the `@`-named event. The asymmetry within one href is
> unchanged: the account segment still goes through `RFC_3986`
> (`account_base_path`, `crates/groupware/src/cache/mod.rs:57-65`), while the
> resource segment goes through `canonical_calcard_segment`
> (`crates/common/src/storage/dav/mod.rs:155-162`), which leaves `@` raw. By
> source read (not observed), a resource stored as `%40` before is now listed
> with a raw `@`. The sections
> below describe 0.16.19–0.16.27; the source pointers in them are at those tags.

## Observe

A CalDAV collection is addressed by a URI, and every response that lists its
members returns each member as a `DAV:href`. The client's only contract is
that the href it is handed can be used to address the resource again. Stalwart
0.16.22 breaks that contract for any resource whose name contains a character
that carries a reserved meaning inside a URI path — `@` is the case we hit,
but the argument is not specific to it.

Three behaviours combine, and the first two are visible in upstream source.

**The encoding is asymmetric within a single href.** The account segment is
percent-encoded (`/dav/cal/user%40example.com/`), while the resource segment of
that same href is emitted verbatim (`…/abc@example.com.ics`). One href, two
encoding conventions — and both are produced by the same function, a dozen
lines apart. In `crates/groupware/src/cache/calcard.rs` at `v0.16.22`, the
account segment goes through `utf8_percent_encode(…, RFC_3986)`
unconditionally (line 56), while the container and resource segments go
through `encode_path_segment` (lines 94, 149, 150). The two disagree about
`@`:

```rust
// crates/groupware/src/lib.rs @ v0.16.22
pub const RFC_3986: &AsciiSet = &CONTROLS. … .add(b'@') … ;   // encodes @

fn is_pchar(byte: u8) -> bool { matches!(byte, … | b'@') }    // accepts @

pub fn encode_path_segment(name: &str) -> Cow<'_, str> {
    if is_uri_segment(name) { Cow::Borrowed(name) }           // … so: verbatim
    else { utf8_percent_encode(name, RFC_3986).into() }
}
```

`RFC_3986` adds `@` to the set it escapes, so the account segment becomes
`%40`. `is_pchar` accepts `@`, so `is_uri_segment` returns true for a resource
name containing one and `encode_path_segment` short-circuits to
`Cow::Borrowed` — the name is returned untouched.

**The request URI's resource segment is never decoded**, and resolution is an
exact string match. Consequently `@` and `%40` are two permanently distinct
resources, and whichever spelling the client did not use answers 404.

**The behaviour arrived in 0.16.19** (2026-08-24). Before that release a `PUT`
to a name containing `@` was rewritten and stored percent-encoded. The
short-circuit above is what changed: `is_pchar`, `is_uri_segment` and
`encode_path_segment` are absent from `crates/groupware/src/lib.rs` at
`v0.16.18` and present at `v0.16.19`. It cannot be waited out — that function
is byte-identical at `v0.16.23` (re-read 2026-09-21) and again at `v0.16.24`, `v0.16.25`, `v0.16.26`
and `v0.16.27`.

The change is deliberate rather than accidental, so a report must argue the
consequence and not the legality; see **Upstream** below.

## Why it matters

The failure is invisible from the server side and from our own API, which is
what makes it expensive. Stalwart holds such an object correctly: `PROPFIND`
at Depth 0 and 1, `calendar-query`, `calendar-multiget`, `sync-collection`,
`getctag` and `supported-report-set` all answer 207/200 with correct data and
a valid advancing sync token. Our own tools return the event. Every check an
operator would think to run passes.

A client that normalizes the href it was given before re-requesting it,
however, addresses the percent-encoded spelling, receives a 404, and drops the
object. Apple Calendar on macOS and iOS behave exactly this way: they poll the
collection every few minutes, receive the data, and discard it. The events are
absent from the client's local store entirely — its own search does not find
them. Nothing is logged, and nothing distinguishes the case from an empty
calendar.

> **Example.** Of the forty-three objects in one collection, eight carried a
> raw `@` in the resource segment of their href, seventeen carried `%40`, and
> eighteen carried no `@` at all. The eight raw-`@` resources were exactly the
> eight events invisible in Apple Calendar. The diagnosis was confirmed by
> intervention: two events differing only in resource name were written to the
> same collection, and the plainly-named one appeared while the `@`-named one
> did not.

The consequence generalizes beyond Apple. Any client that round-trips an href
through a URI library before re-requesting it is exposed, and the object it
loses is one the server will keep reporting as present.

## What is not the cause

Two properties of the affected objects were tested against a live server and
ruled out, so that the next investigation does not repeat them.

- **The UID form.** All twenty-five events created by our tools carried
  `<uuid>@<domain>` UIDs, yet seventeen of them rendered. Only the stored
  resource name separates the two groups.
- **A floating `DTSTAMP` and an `ORGANIZER` on an attendee-less event.** The
  floating `DTSTAMP` was a genuine defect — RFC 5545 §3.8.7.2 makes the value
  UTC — and was corrected. The `ORGANIZER` was not a defect: RFC 5545 §3.8.4.3
  requires it only for a group-scheduled component, so on a personal event it
  is optional, and Apple Calendar emits it too. We now omit it on a personal
  event we create, as a matter of taste rather than correctness. Either way,
  an event carrying neither was still invisible when its resource name
  contained a raw `@`.

Apple's half of the mechanism — that CalendarAgent re-encodes a server-supplied
href — is **inferred, not evidenced**. No public report exists of Apple
Calendar failing on a raw `@` in a resource href. The mechanism is documented
for DAVx⁵ against iCloud and for iCal 3.0.3, but never for a current
CalendarAgent, and stock Foundation does not escape `@` in a path. The
correlation above is strong and the fix is ours to make either way, so proving
Apple's half was not pursued.

## Workaround

Resource names are generated as a bare UUID plus an `.ics` extension,
independently of the event UID and of anything else inside the object
(`newEventResourceName` in `src/caldav/client.ts`). Such a name
contains only unreserved characters, so it has exactly one spelling and the
asymmetry cannot bite.

Although the immediate motivation is this defect, the naming is what RFC 4791
asks for regardless: §5.3.2 states that a calendar object resource's URL need
bear no relationship to the object's properties, and §11 states that the
resource name must not expose data from inside the object. Apple's own client,
Thunderbird, Evolution, sabre, xandikos and Stalwart's own iTIP writer all
generate names this way. The workaround and the correct implementation
coincide, which is why it is safe to keep after the defect is fixed.

Two regression guards exist.
`src/caldav/caldav-integration.test.ts` writes an event through
the live client and asserts that the resource segment of the stored href
contains no `@`, no `%40`, and nothing derived from the UID; it is the test
that would have caught this. `src/caldav/client.test.ts` asserts
that a generated name survives `encodeURIComponent` unchanged.

The seventeen already-stored `%40`-named resources are left alone. They
render correctly, and rewriting them would be gratuitous risk.

## Upstream

Not filed by us. The investigation that produced this entry recorded that the
asymmetry is already tracked in an existing topic on the Stalwart support
portal and that upstream has deferred the fix to v1.0, and decided on that
basis not to open a second report. **That topic's URL was not captured, so
neither claim is verifiable from this file.** Until it is, treat "already
tracked" as unconfirmed: either find the topic, paste the URL here and flip
`status` to `filed`, or file one through the channel in
[`AGENTS.md`](AGENTS.md#reporting).

The defensible framing for that report is encoding consistency and round-trip
safety, not legality. A raw `@` in a path segment is permitted by RFC 3986 —
it is a `pchar` — so a report arguing that Stalwart emits an illegal href is
wrong on the facts and would rightly be dismissed. The defect is that one href
mixes two encoding conventions across its own segments, and that the server
treats the encoded and decoded spellings of one name as two resources.

Proposed fix: percent-decode the resource segment of a request URI before
resolving it, so that `@` and `%40` address the same object, and apply one
encoding convention to every segment of an emitted href. 1.0.0 shipped the
first half. What remains to report is the second, which is cosmetic now that
lookup no longer depends on the spelling.

## Drop workaround when

The workaround is also the RFC-correct implementation, so it stays either way;
this entry retires when the server behaviour is fixed, not when the code
changes.

Verify by writing two calendar objects to one collection under the names
`probe@example.com.ics` and `probe%40example.com.ics`, then requesting each
under both spellings. The clause is satisfied when both spellings resolve to
the same single resource, and when the href returned by `PROPFIND` for it uses
the same encoding convention as the account segment of that same href. At
1.0.0 the first half holds and the second does not
(`src/caldav/stalwart-move-event.test.ts` pins the first half
and that the resource segment keeps a raw `@`; the account segment's
encoding is a source read).

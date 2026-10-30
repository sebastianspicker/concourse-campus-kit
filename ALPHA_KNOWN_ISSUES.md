# Known issues in the alpha

This alpha is for testing. Some things are known not to work yet, or to work
only in part. This page lists them so you don't spend time reporting them, and
explains how to report anything else.

## Using the app

- **Some events have no date, or show only the calendar's name.** The app
  reads event dates from the institution's web pages. It understands dates that
  pages mark up for machines, and dates written like `04.11.2026` or
  `04.11.2026 19:30`. It does not yet understand dates written out in words,
  such as "4 November 2026". Events whose date it can't read are left out. If
  it can't read any event on a page, you see one entry named after that page
  and a notice that the data is limited.
  *Workaround:* open the institution's own events page from the app.
- **At most 8 events per events page.** The app shows up to 8 events from
  each events page the institution has set up. Later events on a long page are
  not shown yet.
- **Very large timetables are shortened.** When an institution's calendars
  together hold more than 1,000 entries, the app keeps the 1,000 nearest
  upcoming ones.
- **"Too many requests" when many people test from one place.** The service
  limits how often one network address may ask for data. If many testers share
  one network (for example, the same campus Wi-Fi behind one address), you may
  see this message. *Workaround:* wait the time the message shows, then pull to
  refresh. The people running the service can raise the limit.
- **Saved data instead of fresh data when the service is slow.** If the
  service is slow or busy, the app shows the data it saved earlier and marks it
  as saved, or tells you why it couldn't load. It does not keep waiting in the
  background for a long time. *Workaround:* pull to refresh a little later.
- **The language setting may not be remembered.** In rare cases, when the
  device can't save settings, the chosen language resets after the app
  restarts. *Workaround:* choose the language again.

## Running your own copy

This section is for staff who set up the service for their institution.

- **Setup on newer Node.js versions.** The setup steps use Corepack, which
  Node.js 25 and later no longer include. *Workaround:* use Node.js 22, or
  install pnpm 9.15.0 yourself and run `pnpm install --frozen-lockfile`.
- **Example settings point at a different institution.** The example API
  settings file names the `hfmt` institution, while the app and the README use
  `example`. *Workaround:* set the same institution for the API and the app,
  as the README shows.
- **Trying it without a real institution.** The bundled `example` institution
  has no real web pages. Start the API with `PUBLIC_EVENTS_MODE=mock`, as the
  README shows, to get sample data without going online. Never use this
  setting for a real deployment.
- **Container image name.** Release builds publish the API image as
  `ghcr.io/<owner>/<repo>/bff` (for this repository,
  `ghcr.io/sebastianspicker/concourse-campus-kit/bff`). Nothing has been
  published under the older name `ghcr.io/sebastianspicker/concourse/bff`.

## How to report a problem

Report bugs with the bug form in the project's GitHub issue tracker, and
general alpha feedback with the alpha feedback form. Report security problems
privately through GitHub Security Advisories, never in a public issue.

Please include:

- what you did, what you expected, and what happened instead;
- the date and time it happened, with your time zone;
- the screen you were on (Today, Events, Rooms, Schedule, or Settings) and
  any message the app showed, ideally as a screenshot;
- your device, operating system and version, and whether you used the app,
  a browser, or the web demo;
- the app version and the institution you tested with;
- whether you were online, and whether the app showed saved or limited data.

If you run the service yourself, also attach the API log lines from around
that time. Each log line carries a request ID (`requestId`) that helps match
your report with what the service saw.

Before you attach anything, remove passwords, access tokens, private web
addresses, and personal data about students or staff.

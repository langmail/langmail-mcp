// The email share_calendar sends when it is given the person's address: what
// they will see, the link, how to add it in each app and who sets the refresh.
// Langmail writes this part, so the link and the menu paths are always right;
// the agent adds only the user's own words (`note`), above it. There is no
// generated greeting: the person is known to the tool only by a label such as
// "my partner", and a greeting that used it would read wrong.
//
// Plain text in English or German, the language the user writes to this person
// in. The menu names are the ones each app shows in that language.

import { type ShareLevel } from '../calendar-feeds/render.ts'

export type ShareEmailLanguage = 'de' | 'en'

export interface ShareEmailParams {
  calendar: string
  language: ShareEmailLanguage
  level: ShareLevel
  link: string
  note?: string
  // How the user's name reads: their display name, else their address.
  sender: string
}

interface Template {
  addTitle: string
  apple: string
  doNotPassOn: string
  google: string
  intro: (sender: string, calendar: string) => string
  link: string
  outlook: string
  refresh: string
  sees: Record<ShareLevel, (sender: string) => string>
  subject: (sender: string, calendar: string) => string
}

const TEMPLATES: Record<ShareEmailLanguage, Template> = {
  de: {
    addTitle: 'So fügst du ihn hinzu:',
    apple:
      '- Apple Kalender: auf dem Mac Ablage → Neues Kalenderabonnement; auf dem iPhone Einstellungen → Apps → ' +
      'Kalender → Kalenderaccounts → Account hinzufügen → Andere → Kalenderabo hinzufügen.',
    doNotPassOn: 'Bitte gib den Link nicht weiter: Wer ihn hat, kann den Kalender sehen.',
    google: '- Google Kalender (am Computer): Weitere Kalender → + → Per URL, dann den Link einfügen.',
    intro: (sender, calendar) => `${sender} teilt den Kalender „${calendar}“ mit dir.`,
    link: 'Link zum Kalender:',
    outlook: '- Outlook: Kalender hinzufügen → Aus dem Web abonnieren, dann den Link einfügen.',
    refresh:
      'Wie oft der Kalender aktualisiert wird, bestimmt deine Kalender-App: Google Kalender holt Änderungen alle ' +
      'paar Stunden, manchmal nur einmal am Tag; Apple Kalender und Outlook alle paar Stunden oder so oft, wie du ' +
      'es einstellst.',
    sees: {
      busy: (sender) => `Du siehst, wann ${sender} beschäftigt ist: Jeder Termin heißt „Busy“, ohne Details.`,
      full: () => 'Du siehst Titel, Zeiten, Orte, Notizen und Gäste; private Termine erscheinen nur als beschäftigt.',
    },
    subject: (sender, calendar) => `${sender} teilt den Kalender „${calendar}“ mit dir`,
  },
  en: {
    addTitle: 'How to add it:',
    apple:
      '- Apple Calendar: on a Mac, File → New Calendar Subscription; on an iPhone, Settings → Apps → Calendar → ' +
      'Calendar Accounts → Add Account → Other → Add Subscribed Calendar.',
    doNotPassOn: 'Please do not pass the link on: anyone who has it can see the calendar.',
    google: '- Google Calendar (on a computer): Other calendars → + → From URL, then paste the link.',
    intro: (sender, calendar) => `${sender} is sharing the calendar "${calendar}" with you.`,
    link: 'Link to the calendar:',
    outlook: '- Outlook: Add calendar → Subscribe from web, then paste the link.',
    refresh:
      'How often the calendar refreshes is up to your calendar app: Google Calendar picks up changes every few ' +
      'hours, sometimes only once a day; Apple Calendar and Outlook every few hours or as often as you set.',
    sees: {
      busy: (sender) => `You see when ${sender} is busy: every event is titled "Busy", with no details.`,
      full: () => 'You see titles, times, locations, notes and guests; private events show only as busy.',
    },
    subject: (sender, calendar) => `${sender} is sharing the calendar "${calendar}" with you`,
  },
}

export const shareEmail = (p: ShareEmailParams): { subject: string; text: string } => {
  const t = TEMPLATES[p.language]
  const note = p.note?.trim()
  const lines = [
    ...(note ? [note, ''] : []),
    t.intro(p.sender, p.calendar),
    t.sees[p.level](p.sender),
    '',
    t.link,
    p.link,
    '',
    t.addTitle,
    t.google,
    t.apple,
    t.outlook,
    '',
    t.refresh,
    '',
    t.doNotPassOn,
    '',
  ]
  return { subject: t.subject(p.sender, p.calendar), text: lines.join('\n') }
}

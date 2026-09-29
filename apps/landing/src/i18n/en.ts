import type { Dict } from './ru';

const en: Dict = {
  meta: {
    title: 'Calab — voice, chat, meetings and tasks for your team, on your own server',
    description:
      'Voice rooms, Telegram-style chat, a calendar with meetings, task boards, notes and guest links — on your own server. Meeting recordings with summaries, bots and an API, works behind VPNs. macOS, Windows, Linux and the browser.',
    ogAlt: 'Calab — the app window during a planning meeting: a shared slide and participants’ cameras',
  },
  header: {
    skip: 'Skip to content',
    home: 'Calab — back to top',
    navLabel: 'Sections',
    nav: {
      features: 'Features',
      calendar: 'Calendar',
      boards: 'Boards',
      download: 'Download',
      pricing: 'Pricing',
      faq: 'FAQ',
      bots: 'Bots',
    },
    openWeb: 'Open in browser',
    openWebShort: 'Web app',
    language: 'Language',
  },
  hero: {
    badge: 'New in 1.1: task boards and Find a time',
    title: 'Your whole team in one window',
    lead: 'Voice rooms, chat, meetings and tasks on your own server. Light like Discord, easy like Telegram.',
    download: 'Download',
    openWeb: 'Open in browser',
    trust: 'Open source (BSL 1.1) · macOS · Windows · Linux · web',
    shotAlt: 'The Calab window during a planning meeting: a “Release 1.1” slide on the stage, participants’ cameras below, the workspace rooms on the left',
  },
  why: {
    title: 'Why Calab',
    items: {
      light: {
        title: 'Light',
        text: '0.05 % CPU outside a call, ≈ 7 % in voice (MacBook Air M4). A hidden window decodes no video.',
      },
      server: {
        title: 'Your own server',
        text: '{code} — and a minute later it all works. Your data stays with you.',
      },
      network: {
        title: 'Behind VPNs and firewalls',
        text: 'UDP blocked? TURN/TLS over port 443, just like regular HTTPS.',
      },
      recording: {
        title: 'Meeting recordings',
        text: 'The transcript and summary arrive as a card in the room chat.',
      },
    },
  },
  features: {
    voice: {
      eyebrow: 'Voice and video',
      title: 'Join a room and start talking',
      text: 'Voice rooms are always open: one click and you’re in the conversation. Cameras, screen sharing and one-on-one calls live right there — no separate links or apps.',
      points: [
        'RNNoise noise suppression and AEC3 echo cancellation — clean even without headphones',
        'Push-to-talk and voice activation, even in the background',
        'Screen sharing in AV1 or hardware H.264, with a pointer and drawing on top',
        'Camera with background blur or a picture',
        'Meeting recordings with a transcript and summary right in the chat',
      ],
      alt: 'A one-on-one call in direct messages: “Call · 00:00” and the “End” button in the header, the voice panel at the bottom',
    },
    chat: {
      eyebrow: 'Chat',
      title: 'Chat like Telegram',
      text: 'Every room has its own chat: replies, reactions, forwarding, stickers, voice messages, files with previews, pins and search. Read ticks, just as you’re used to.',
      points: ['Forward to several chats at once', 'Workspace sticker packs', 'Voice messages, music and video with a built-in player', 'Mentions, per-room notifications, workspace search'],
      alt: 'The “general” room: a mockup with reactions, a reply to it, a sticker and the members online',
    },
    calendar: {
      eyebrow: 'Calendar and meetings',
      title: 'Meetings where the conversation is',
      text: 'The calendar is built into the app: your day of meetings, invitations, attendees’ answers, the meeting room with a “Go” button and reminders 15 minutes before.',
      cards: {
        invites: { title: '.ics invitations', text: 'An email with invite.ics adds the meeting to Apple, Google, Outlook or Yandex calendars. External attendees answer by link and join as guests.' },
        find: { title: 'Find a time', text: 'Colleagues’ busy columns, shared free windows and the nearest slots — one click creates the meeting.' },
        caldav: { title: 'CalDAV', text: 'Connect Yandex, iCloud, Fastmail or Nextcloud: your busy time counts, and Calab meetings show up there by themselves.' },
      },
      alt: 'The day view: meetings side by side, the red “now” line and the “Release planning” meeting card with attendees',
      findAlt: '“Find a time” for four people: busy columns, the green shared window and the picked slot',
    },
    boards: {
      eyebrow: 'Task boards',
      title: 'Tasks next to the conversation',
      text: 'Kanban, list and timeline in the spirit of Linear — without another service. Create a task from any message; a link to it unfolds into a card in the chat.',
      points: ['Statuses, priorities, labels, milestones and due dates', 'Several assignees, subtasks and relations', 'Comments like chat: reactions, stickers, voice messages', 'Filters, saved views and keyboard shortcuts'],
      free: 'Free includes 3 boards; Team and Enterprise are unlimited.',
      alt: 'The “Product” board as a kanban: status columns with task cards, labels, due dates and assignees',
      timelineAlt: 'The board timeline: task bars by date, the “today” line and the “Release 1.1” milestone',
      taskAlt: 'The task panel: subtasks, a “blocks” relation, history and chat-like comments',
    },
    notes: {
      eyebrow: 'Notes',
      title: 'Private shelves for everything important',
      text: 'Up to 20 shelves with your own names and emoji — like Saved Messages in Telegram, only several. Only you can see a shelf.',
      points: ['Drag a message onto a shelf or forward it', 'Drop files from Finder or Explorer straight onto a shelf', 'Pins and search, as in any chat'],
      alt: 'Notes: the “Ideas”, “Links” and “For the release” shelves and an open shelf with notes and a forwarded message',
    },
    guests: {
      eyebrow: 'Guests',
      title: 'Guests without sign-up — with your approval',
      text: 'A guest link leads straight into the room: the guest types a name and joins the conversation. Want control? Turn on approval: the organizer sees “asks to join” and clicks “Let in”.',
      points: ['A guest sees only their room', 'Approval per room or per link', 'A sound and a waiting counter for the organizer'],
      alt: 'The guest’s screen: “Waiting for the organizer’s approval…” with the room name and a “Cancel” button',
    },
    bots: {
      eyebrow: 'Bots and SDK',
      title: 'A bot is a member like everyone else',
      text: 'A bot uses the same API as the app: it writes in chat, answers /commands, talks in voice rooms and works with boards within its rights.',
      points: ['TypeScript SDK, Node and Python examples', 'Events over WebSocket or a webhook signed with HMAC', 'Rights through roles, like people'],
      link: 'More about the Bot API',
    },
    selfhost: {
      eyebrow: 'Self-hosted and secure',
      title: 'Your server, your data',
      text: 'Calab installs on your Linux server with one command and depends on no external services.',
      step: 'Step {n}.',
      steps: {
        server: { title: 'Set up the server', text: 'A Linux host with Docker and a domain. One command and it’s running within a minute; Let’s Encrypt certificates are issued automatically.' },
        install: { title: 'Install the app', text: 'macOS, Windows or Linux. Or just open Calab in your browser — nothing to install.' },
        invite: { title: 'Invite your team', text: 'Send an invite link. Guests joining a single meeting don’t need an account.' },
      },
      security: {
        tls: { title: 'Encrypted in transit', text: 'The API and signaling use TLS; voice and video use DTLS-SRTP.' },
        data: { title: 'Your data stays yours', text: 'Messages, files and recordings are stored only on your server.' },
        network: { title: 'Works behind a VPN', text: 'UDP blocked? TURN/TLS over 443 — to the network it’s ordinary HTTPS.' },
        roles: { title: 'Rights for everything', text: 'Roles and per-room and per-board rights are checked by the server.' },
      },
    },
  },
  downloads: {
    eyebrow: 'Download',
    title: 'Apps for every platform',
    lead: 'An Electron client with global hotkeys, push-to-talk in the background and sharing of any window.',
    primary: {
      mac: 'Download for macOS',
      win: 'Download for Windows',
      linux: 'Download for Linux',
      macIntel: 'Intel',
      macIntelLabel: 'Download for Intel-based Macs',
      linuxDebLabel: 'Download the .deb package for Linux',
      version: 'Version',
      allVersions: 'All versions',
    },
    platforms: {
      mac: {
        format: 'DMG, macOS 12 or later',
        note: 'Signed with a Developer ID and notarized by Apple, so it opens without warnings.',
      },
      win: {
        format: '.exe installer, Windows 10 and 11',
        note: 'The build isn’t signed yet: on first launch SmartScreen shows “Unknown publisher” → “More info” → “Run anyway”.',
        file: 'Download .exe',
      },
      linux: {
        format: 'x64',
        note: 'Make the AppImage executable before running it: {code}.',
      },
    },
    web: 'Or open the {link} in Chrome, Edge, Safari or Firefox.',
    webLink: 'web app',
    whatsNew: 'What’s new:',
    changelog: 'Changelog',
    releases: 'Releases on GitHub',
  },
  pricing: {
    eyebrow: 'Pricing',
    title: 'Free, Team, Enterprise or your own server',
    lead: 'Start for free. Need more? Team or Enterprise in the cloud, or Calab on your own server.',
    startHere: 'Start here',
    plans: {
      free: { name: 'Free', price: 'Free', note: 'For small teams: up to 5 people per room' },
      team: { name: 'Team', price: 'On request', note: 'Up to 50 people per room, unlimited video' },
      enterprise: { name: 'Enterprise', price: 'On request', note: 'Cloud without limits and priority support' },
      selfHosted: { name: 'Self-hosted', price: 'Your server', note: 'Your infrastructure, BSL 1.1 licence' },
    },
    cta: {
      web: 'Web app',
      download: 'Download',
      contact: 'Contact us',
      license: 'Licence terms',
    },
    table: {
      caption: 'Plan comparison',
      feature: 'Feature',
      details: 'What’s included',
      unlimited: 'unlimited',
      no: 'no',
      yes: 'yes',
      rows: {
        room: 'Voice room',
        members: 'Workspace members',
        audio: 'Audio quality',
        video: 'Screen sharing and camera',
        streams: 'Screen shares per room',
        files: 'Files',
        bots: 'Bots',
        stickers: 'Sticker packs',
        boards: 'Task boards',
        calendar: 'Calendar',
        caldav: 'CalDAV',
        support: 'Support',
        price: 'Price',
      },
      cells: {
        room: ['up to 5', 'up to 50', '∞', '∞'],
        members: ['up to 50', '∞', '∞', '∞'],
        audio: ['up to Normal', 'any', 'any', 'any'],
        video: ['720p, 15 fps', '∞', '∞', '∞'],
        streams: ['1', '∞', '∞', '∞'],
        files: ['5 GB', '1 TB', '∞', '∞'],
        bots: ['1', '20', '∞', '∞'],
        stickers: ['1', '∞', '∞', '∞'],
        boards: ['3', '∞', '∞', '∞'],
        calendar: ['✓', '✓', '✓', '✓'],
        caldav: ['✓', '✓', '✓', '✓'],
        support: ['—', '✓', 'priority', '—'],
        price: ['free', 'on request', 'on request', 'BSL 1.1; commercial on request'],
      },
    },
    license:
      'Self-hosted: free for non-commercial use, with “Powered by GPTunneL” in the interface; commercial use under a GPTunneL licence. Every Calab version moves to the Apache License 2.0 four years after release.',
    licenseLink: 'Licence text',
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'The short version',
    items: {
      server: {
        q: 'What do I need to run my own server?',
        a: 'A Linux host with Docker, a public IP and a domain. Open ports: 80 and 443 (TCP and UDP), 7881/TCP, 7882/UDP. A team of up to 30 people needs roughly 4 vCPUs and 8 GB of RAM; the exact figure depends on how many screens are shared at once.',
      },
      recording: {
        q: 'What are meeting recordings, and where does the audio go?',
        a: 'A workspace connects to GPTunneL once, with a code in the settings. Then any member except guests can record in a voice room; the server does the recording. After the meeting the audio goes to GPTunneL for transcription, and a card with the summary and the full transcript arrives in the room chat; the audio is kept as the card’s attachment for 30 days. Recording can be disabled in the room settings.',
      },
      traffic: {
        q: 'How much bandwidth does Calab use?',
        a: 'Voice takes 16–64 kbps per speaker (32 by default) and about 1 kbps during silence. Sharing a static screen takes 20–300 kbps, capped at 2 Mbps for 1080p. The server sends each viewer the quality their connection can handle.',
      },
      updates: {
        q: 'How does the app update?',
        a: 'The desktop app updates itself on launch. The macOS build is signed and notarized by Apple; the Windows build isn’t signed yet, so SmartScreen may show a warning. The web app is always up to date.',
      },
      whatsNew: {
        q: 'What’s new in 1.1?',
        a: 'Task boards — kanban, list and timeline, tasks from messages and chat-like comments; “Find a time” across colleagues’ calendars and an external calendar over CalDAV. 1.0 brought the calendar and meetings, Notes and guest approval. The full list is in the {changelog}.',
      },
      security: {
        q: 'How is the connection secured?',
        a: 'The API and signaling use TLS; voice and video use DTLS-SRTP. Messages and files are stored only on your server. There is no end-to-end encryption yet: media passes through your media server.',
      },
      firewall: {
        q: 'Does it work over a VPN or a corporate firewall?',
        a: 'Yes. If UDP isn’t available, the client switches to TCP and then to TURN/TLS on port 443 — to the network it looks like ordinary HTTPS.',
      },
      limits: {
        q: 'What are the limits of the current version?',
        a: 'It’s designed for 20–30 people online at the same time and up to three screen shares per room. Horizontal scaling is on the roadmap.',
      },
      roomLimit: {
        q: 'What happens when a 6th person tries to join a room?',
        a: 'On the Free plan, a voice room holds up to 5 people at once. The 6th person can’t join — they’ll see a message about the plan limit and an option to move to Team.',
      },
      license: {
        q: 'How do I get a commercial license for self-hosting?',
        a: 'Email {email} and tell us about your company and use case — we’ll send you the terms.',
      },
      enterprise: {
        q: 'How is Enterprise different from Team and self-hosted?',
        a: 'Team is the cloud with limits: up to 50 people per room, up to 1 TB of files, 20 bots, and support. Enterprise is the cloud too, but with no limits at all, like your own server, and with priority support. Self-hosted is Calab on your own infrastructure under BSL 1.1, with no limits. Team and Enterprise are priced on request at {email}.',
      },
      buyTeam: {
        q: 'How do I buy Team?',
        a: 'Email us at {email} — we usually turn the plan on within a day.',
      },
    },
    changelogLink: 'changelog',
  },
  footer: {
    navLabel: 'Documents',
    license: 'License',
    commercial: 'Commercial license',
    security: 'Security',
    trademarks: 'Trademarks',
    bots: 'Bot API',
  },
  bots: {
    meta: {
      title: 'Calab bots — chat, voice and commands over an API',
      description:
        'Calab bots are members with a token: they read and write chat, answer /commands, get events over WebSocket or a webhook and talk in voice rooms through LiveKit. TypeScript SDK, Node and Python examples.',
    },
    eyebrow: 'Bots',
    title: 'A bot is a member like everyone else',
    lead: 'Create a bot in the workspace settings and give it a role — it works through the same API as the app: chat, commands, voice.',
    cards: {
      chat: {
        title: 'Chat',
        text: 'Reads and writes messages, replies, reacts, sends files and stickers, writes direct messages. Events arrive in real time over WebSocket.',
      },
      voice: {
        title: 'Voice',
        text: 'Joins a voice room through LiveKit: hears the participants and speaks itself — text to speech, echo, music, recording. In Node, Python or Go.',
      },
      commands: {
        title: 'Commands',
        text: 'Registers /commands — the composer suggests them on “/”. A /cmd message reaches the bot with its arguments parsed.',
      },
      webhook: {
        title: 'Webhook',
        text: 'No open connection needed: events arrive as signed (HMAC) POST requests, retried on failure. Handy for serverless.',
      },
    },
    rights: 'Rights come from roles, as for people: a bot sees only the rooms it was let into.',
    codeTitle: 'An echo bot in TypeScript',
    codeCaption: 'This one and three more — voice echo, text to speech and a Python listener — are in {examples}.',
    ctaTitle: 'Your first bot in 5 minutes',
    ctaText: 'Token, REST, events, webhook, voice, limits and error codes — all in the docs.',
    docs: 'Bot API docs',
    docsLang: '',
    sdk: 'SDK on GitHub',
  },
};

export default en;

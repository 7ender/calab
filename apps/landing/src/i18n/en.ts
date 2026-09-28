import type { Dict } from './ru';

const en: Dict = {
  meta: {
    title: 'Calab — voice, chat and calls for your team, on your own server',
    description:
      'Voice rooms, chat, calls and screen sharing for your team, on your own server. Meeting recordings with transcripts and summaries, bots and an API, works behind VPNs and firewalls. macOS, Windows, Linux and the browser.',
    ogAlt: 'Calab — the app window with a team chat',
  },
  header: {
    skip: 'Skip to content',
    home: 'Calab — back to top',
    navLabel: 'Sections',
    nav: {
      features: 'Features',
      how: 'Get started',
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
    title: 'Voice, chat and calls for your team — on your own server',
    benefits: ['Light like Discord', 'Your own server in a minute', 'Meeting recordings with summaries'],
    download: 'Download',
    openWeb: 'Open in browser',
    trust: 'Open source (BSL 1.1) · macOS · Windows · Linux · web',
    shotAlt: 'The Calab window: the “Команда Calab” workspace, the “общий” room with messages, a voice room and members online',
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
    eyebrow: 'Features',
    title: 'Voice, screen and chat in one window',
    lead: 'One click to join a room, and you’re talking. Everything else is right at hand.',
    items: {
      voice: {
        title: 'Voice without echo or noise',
        text: 'Voice activation or push-to-talk, even in the background. RNNoise noise suppression and AEC3 echo cancellation keep it clean, even without headphones.',
        points: ['Quality levels from Low to Excellent', 'Opus at 16–64 kbps, about 1 kbps in pauses', 'Reconnects without leaving the room'],
        alt: 'The “Переговорка” voice room: Boris Petrov is speaking, the RNNoise noise suppression popover is open',
      },
      stream: {
        title: 'Screen sharing and camera',
        text: 'Share your screen in AV1 or hardware H.264 — the graphics card does the encoding, not the CPU. Viewers can draw and point on top of the stream.',
        points: ['720p, 1080p or native resolution', 'A static screen takes 20–300 kbps', 'Each viewer gets the quality their connection allows'],
        alt: 'Vera Kim sharing her screen with a LIVE badge: a “Релиз 0.2” slide with a checklist',
      },
      chat: {
        title: 'Chat like Telegram',
        text: 'Every voice room has its own chat. Replies, reactions, forwarding, stickers, voice messages, files with previews, pins and search.',
        points: ['Forward to several chats at once', 'Workspace sticker packs, animated too', 'Voice messages, music and video with a built-in player'],
        alt: 'A message with a link preview card, followed by a message with an image',
      },
      dm: {
        title: 'Direct messages and calls',
        text: 'One-on-one chats and a call in one click — from the member menu, the profile or the conversation header. Incoming calls ring and notify you.',
        points: ['Camera and screen sharing in a call', 'Missed and declined calls in the feed', 'Conversation archive'],
        alt: 'A call in direct messages with Boris Petrov: “Звонок · 00:00” and the “Завершить” button',
      },
      recording: {
        title: 'Meeting recordings with summaries',
        text: 'Start recording in a voice room — after the meeting a card with the summary, audio and full transcript lands in the chat. Transcription by GPTunneL.',
        points: ['Search the transcript and jump to any line', 'Topics and decisions in the summary', 'Forward a recording or reply to it'],
        alt: 'The “Встреча записана · 42 мин” card: a summary with topics and decisions, “Ответить” and “Полный транскрипт” buttons',
      },
      bots: {
        title: 'Bots and API',
        text: 'A bot is a member with a token: it writes in chat, answers /commands and talks in voice rooms. TypeScript SDK, events over WebSocket or webhook.',
        link: 'More about the Bot API',
      },
      mobile: {
        title: 'On your phone',
        text: 'The web app adapts to the screen: rooms in a drawer, voice and push-to-talk at the bottom. Add it to your home screen like an app.',
        alt: 'Calab on an iPhone: the “общий” room with messages and the message field',
      },
    },
  },
  how: {
    eyebrow: 'How it works',
    title: 'Three steps to your first call',
    step: 'Step {n}.',
    steps: {
      server: {
        title: 'Set up the server',
        text: 'A Linux host with Docker and a domain. One command and it’s running within a minute; Let’s Encrypt certificates are issued automatically.',
      },
      install: {
        title: 'Install the app',
        text: 'macOS, Windows or Linux. Or just open Calab in your browser — nothing to install.',
      },
      invite: {
        title: 'Invite your team',
        text: 'Send an invite link. Guests joining a single meeting don’t need an account.',
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
        q: 'What’s new in 0.8.0?',
        a: 'One-on-one calls in direct messages, audio quality levels, Telegram-style read ticks, the Enterprise plan and replies to meeting recording cards. The full list is in the {changelog}.',
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

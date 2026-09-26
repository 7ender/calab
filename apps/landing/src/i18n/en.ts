import type { Dict } from './ru';

const en: Dict = {
  meta: {
    title: 'Calab — voice, chat and screen sharing for teams',
    description:
      'Voice rooms, chat and screen sharing for your team, on your own server. No echo or noise, AV1 screen sharing from 20 kbps, works behind VPNs and firewalls. macOS, Windows, Linux and the browser.',
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
      pricing: 'License',
      faq: 'FAQ',
    },
    openWeb: 'Open in browser',
    openWebShort: 'Web app',
    language: 'Language',
  },
  hero: {
    tagline: 'Voice rooms, chat and screen sharing for your team — on your own server',
    download: 'Download',
    openWeb: 'Open in browser',
    platforms: 'macOS, Windows, Linux and the browser',
    shotAlt: 'The Calab window: the “Calab Team” workspace, the “general” room with messages and members online',
  },
  features: {
    eyebrow: 'Features',
    title: 'Voice, screen and chat in one window',
    lead: 'Join a room in one click and start talking. Everything else is right there.',
    items: {
      voice: {
        title: 'Voice without echo or noise',
        text: 'Voice activation or push-to-talk. RNNoise noise suppression and AEC3 echo cancellation keep it clean even without headphones. Opus at 16–64 kbps, about 1 kbps during silence.',
        alt: 'Choosing the microphone mode: voice activation or push-to-talk',
      },
      stream: {
        title: 'Screen sharing in AV1',
        text: '720p, 1080p or native resolution. Static text and code take 20–300 kbps, so your screen stays readable even on mobile data. Up to three screen shares per room.',
        alt: 'Vera Kim sharing her screen with a LIVE badge: a “Release 0.2” slide with a checklist',
      },
      chat: {
        title: 'Chat that feels like Telegram',
        text: 'Files, reactions, replies, pins, mentions and search. Every voice room has its own chat.',
        alt: 'A message with a link preview card, followed by a message with an image',
      },
      dm: {
        title: 'Direct messages',
        text: 'One-on-one conversations with anyone from your shared workspaces, in their own section with an unread counter. Same feed: files, reactions, pins.',
        alt: 'The list of direct messages and a conversation with Boris Petrov: a release checklist and an invitation to a call',
      },
      mobile: {
        title: 'On your phone',
        text: 'The web app adapts to a phone screen: rooms and conversations in a drawer, voice and push-to-talk at the bottom. Add it to the home screen like an app.',
        alt: 'Calab on an iPhone: the “общий” channel with messages and the message field',
      },
      roles: {
        title: 'Roles, permissions and guest links',
        text: 'Permissions at the workspace and room level. Guests join with a link, no account needed, and see only their room.',
        alt: 'Guest link settings: joining without an account, guest permissions and an active calab.ru/r/… link',
      },
      network: {
        title: 'Works behind VPNs and firewalls',
        text: 'If UDP is blocked, media falls back to TCP and then to TURN/TLS on port 443, which looks like ordinary HTTPS. If the connection drops, it recovers without leaving the room.',
        order: 'Connection fallback order',
      },
      server: {
        title: 'Your server, your data',
        text: 'Caddy, LiveKit, a Go API, Postgres and Valkey in a single Docker Compose file. Messages, files and media never leave your infrastructure. Kubernetes is next.',
      },
    },
    inspiredTitle: 'What inspired us',
    inspired: {
      discord: 'Structure: workspaces, voice and text rooms, roles.',
      telegram: 'Chats that just work: replies, reactions, files, search.',
      zoom: 'A stable connection: adapts to your network and reconnects without dropping you.',
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
    eyebrow: 'License',
    title: 'Free for non-commercial use',
    lead: 'The source code is open. Commercial use requires a license from GPTunneL.',
    free: {
      name: 'Non-commercial use',
      price: 'Free',
      items: [
        'Personal projects',
        'Non-profits, education and research',
        'Evaluation at any company for up to 30 days',
        'Requirement: “Powered by GPTunneL” in the interface',
      ],
      cta: 'Download',
    },
    commercial: {
      name: 'Commercial license',
      price: 'On request',
      items: [
        'Use in your business and for your clients',
        'Self-hosted on your servers or managed hosting',
        'Terms that fit your team size',
      ],
      cta: 'Contact us',
    },
    license:
      'Calab is distributed under the Business Source License 1.1. Each version converts to the Apache License 2.0 four years after its release.',
    licenseLink: 'License text',
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'The short version',
    items: {
      server: {
        q: 'What do I need to run my own server?',
        a: 'A Linux host with Docker, a public IP and a domain. Open ports: 80 and 443 (TCP and UDP), 7881/TCP, 7882/UDP. A team of up to 30 people needs roughly 4 vCPUs and 8 GB of RAM; the exact figure depends on how many screens are shared at once.',
      },
      traffic: {
        q: 'How much bandwidth does Calab use?',
        a: 'Voice takes 16–64 kbps per speaker (32 by default) and about 1 kbps during silence. Sharing a static screen takes 20–300 kbps, capped at 2 Mbps for 1080p. The server sends each viewer the quality their connection can handle.',
      },
      updates: {
        q: 'How does the app update?',
        a: 'The desktop app updates itself on launch. The macOS build is signed and notarized by Apple; the Windows build isn’t signed yet, so SmartScreen may show a warning. The web app is always up to date.',
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
      license: {
        q: 'How do I get a commercial license?',
        a: 'Email {email} and tell us about your company and use case — we’ll send you the terms.',
      },
    },
  },
  footer: {
    navLabel: 'Documents',
    license: 'License',
    commercial: 'Commercial license',
    security: 'Security',
    trademarks: 'Trademarks',
  },
};

export default en;

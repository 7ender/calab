import type { Dict } from './ru';

// Simplified Chinese (zh-CN).
const zh: Dict = {
  meta: {
    title: 'Calab — 团队语音、聊天与屏幕共享',
    description:
      '为团队打造的语音房间、聊天和屏幕共享，部署在你自己的服务器上。无回声、无噪音，AV1 屏幕共享低至 20 kbps，可穿透 VPN 和防火墙。支持 macOS、Windows、Linux 和浏览器。',
    ogAlt: 'Calab 应用窗口与团队聊天',
  },
  header: {
    skip: '跳到正文',
    home: 'Calab — 返回顶部',
    navLabel: '页面导航',
    nav: {
      features: '功能',
      how: '快速开始',
      download: '下载',
      pricing: '许可',
      faq: '常见问题',
    },
    openWeb: '在浏览器中打开',
    openWebShort: '网页版',
    language: '语言',
  },
  hero: {
    tagline: '团队语音房间、聊天与屏幕共享，部署在你自己的服务器上',
    download: '下载',
    openWeb: '在浏览器中打开',
    platforms: '支持 macOS、Windows、Linux 和浏览器',
    shotAlt: 'Calab 窗口：“Calab 团队”工作区，“综合”房间中的消息和在线成员',
  },
  features: {
    eyebrow: '功能',
    title: '语音、屏幕与聊天，尽在一个窗口',
    lead: '一键进入房间，直接开口交流。其他一切触手可及。',
    items: {
      voice: {
        title: '语音清晰，无回声、无噪音',
        text: '语音激活或按键说话。RNNoise 降噪与 AEC3 回声消除，不戴耳机也清晰。Opus 编码 16–64 kbps，静音时约 1 kbps。',
        alt: '选择麦克风模式：语音激活或按键说话',
      },
      stream: {
        title: 'AV1 屏幕共享',
        text: '720p、1080p 或原始分辨率。静态文字和代码仅需 20–300 kbps，用移动网络也能看清屏幕。每个房间最多三路屏幕共享。',
        alt: 'Vera Kim 正在共享屏幕，带有 LIVE 标记：一张带清单的“0.2 版本发布”幻灯片',
      },
      chat: {
        title: '像 Telegram 一样好用的聊天',
        text: '文件、表情回应、回复、置顶、提及和搜索。每个语音房间都有自己的聊天。',
        alt: '一条带链接预览卡片的消息，下方是一条图片消息',
      },
      roles: {
        title: '角色、权限与访客链接',
        text: '可在工作区和房间两级设置权限。访客无需账号即可通过链接加入，且只能看到自己的房间。',
        alt: '访客链接设置：无需账号加入、访客权限，以及一个有效的 calab.ru/r/… 链接',
      },
      network: {
        title: '可穿透 VPN 和防火墙',
        text: '如果 UDP 被封锁，媒体会切换到 TCP，再切换到经 443 端口的 TURN/TLS，流量看起来就是普通的 HTTPS。连接中断后会自动恢复，无需退出房间。',
        order: '连接回退顺序',
      },
      server: {
        title: '你的服务器，你的数据',
        text: 'Caddy、LiveKit、Go 编写的 API、Postgres 和 Valkey，全部在一个 Docker Compose 中。消息、文件和媒体都不会离开你的基础设施。下一步支持 Kubernetes。',
      },
    },
    inspiredTitle: '灵感来源',
    inspired: {
      discord: '结构：工作区、语音和文字房间、角色。',
      telegram: '好用的聊天：回复、表情回应、文件、搜索。',
      zoom: '稳定的连接：自适应网络状况，断线重连无需退出。',
    },
  },
  how: {
    eyebrow: '使用方式',
    title: '三步开启第一次通话',
    step: '第 {n} 步：',
    steps: {
      server: {
        title: '部署服务器',
        text: '一台装有 Docker 并绑定域名的 Linux 主机。一条命令，一分钟内即可运行，Let’s Encrypt 证书自动签发。',
      },
      install: {
        title: '安装应用',
        text: 'macOS、Windows 或 Linux。也可以直接在浏览器中打开 Calab，无需安装。',
      },
      invite: {
        title: '邀请团队',
        text: '发送邀请链接。只参加一次会议的访客无需注册账号。',
      },
    },
  },
  downloads: {
    eyebrow: '下载',
    title: '全平台应用',
    lead: '基于 Electron 的客户端：全局快捷键、后台按键说话、共享任意窗口。',
    primary: {
      mac: '下载 macOS 版',
      win: '下载 Windows 版',
      linux: '下载 Linux 版',
      macIntel: 'Intel',
      macIntelLabel: '下载适用于 Intel 处理器 Mac 的版本',
      linuxDebLabel: '下载 Linux 版 .deb 安装包',
      version: '版本',
      allVersions: '所有版本',
    },
    platforms: {
      mac: {
        format: 'DMG，macOS 12 及更高版本',
        note: '已使用 Developer ID 签名并经 Apple 公证，打开时不会出现警告。',
      },
      win: {
        format: '.exe 安装程序，Windows 10 和 11',
        note: '安装包暂未签名：首次运行时 SmartScreen 会提示“未知发布者”，请点击“更多信息”→“仍要运行”。',
        file: '下载 .exe',
      },
      linux: {
        format: 'x64',
        note: '运行前请为 AppImage 添加可执行权限：{code}。',
      },
    },
    web: '或者在 Chrome、Edge、Safari 或 Firefox 中打开{link}。',
    webLink: '网页版',
    whatsNew: '更新内容：',
    changelog: '更新日志',
    releases: 'GitHub 发布页',
  },
  pricing: {
    eyebrow: '许可',
    title: '非商业用途免费',
    lead: '源代码公开。商业用途需要获得 GPTunneL 的许可。',
    free: {
      name: '非商业用途',
      price: '免费',
      items: [
        '个人项目',
        '非营利组织、教育和科研',
        '任何公司均可评估使用，最长 30 天',
        '条件：界面中保留“Powered by GPTunneL”',
      ],
      cta: '下载',
    },
    commercial: {
      name: '商业许可',
      price: '按需报价',
      items: ['用于企业业务及为客户提供服务', '自托管在你的服务器上，或选择托管部署', '根据团队规模定制条款'],
      cta: '联系我们',
    },
    license: 'Calab 以 Business Source License 1.1 发布。每个版本在发布四年后转为 Apache License 2.0。',
    licenseLink: '许可证全文',
  },
  faq: {
    eyebrow: '常见问题',
    title: '要点速览',
    items: {
      server: {
        q: '自建服务器需要什么？',
        a: '一台装有 Docker 的 Linux 主机、一个公网 IP 和一个域名。需开放端口：80 和 443（TCP 和 UDP）、7881/TCP、7882/UDP。30 人以内的团队大约需要 4 个 vCPU 和 8 GB 内存；具体取决于同时进行的屏幕共享数量。',
      },
      traffic: {
        q: 'Calab 需要多少流量？',
        a: '语音每位发言者 16–64 kbps（默认 32），静音时约 1 kbps。共享静态屏幕 20–300 kbps，1080p 上限 2 Mbps。服务器会根据每位观看者的网络状况发送相应画质。',
      },
      updates: {
        q: '应用如何更新？',
        a: '桌面版在启动时自动更新。macOS 版已签名并经 Apple 公证；Windows 版暂未签名，SmartScreen 可能会发出警告。网页版始终是最新的。',
      },
      security: {
        q: '连接如何保障安全？',
        a: 'API 和信令使用 TLS，语音和视频使用 DTLS-SRTP。消息和文件只存储在你的服务器上。目前尚不支持端到端加密：媒体会经过你的媒体服务器。',
      },
      firewall: {
        q: '能在 VPN 和企业防火墙后使用吗？',
        a: '可以。如果 UDP 不可用，客户端会切换到 TCP，再切换到经 443 端口的 TURN/TLS——对网络来说就是普通的 HTTPS。',
      },
      limits: {
        q: '当前版本有哪些限制？',
        a: '适用于同时在线 20–30 人，每个房间最多三路屏幕共享。水平扩展已在计划中。',
      },
      license: {
        q: '如何获取商业许可？',
        a: '请发送邮件至 {email}，介绍你的公司和使用场景，我们会将条款发给你。',
      },
    },
  },
  footer: {
    navLabel: '文档',
    license: '许可证',
    commercial: '商业许可',
    security: '安全',
    trademarks: '商标',
  },
};

export default zh;

import type { Dict } from './ru';

// Simplified Chinese (zh-CN).
const zh: Dict = {
  meta: {
    title: 'Calab — 团队语音、聊天与通话，部署在你自己的服务器上',
    description:
      '为团队打造的语音房间、聊天、通话和屏幕共享，部署在你自己的服务器上。会议录音附带转写和摘要，支持机器人和 API，可穿透 VPN 和防火墙。支持 macOS、Windows、Linux 和浏览器。',
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
      pricing: '价格',
      faq: '常见问题',
      bots: '机器人',
    },
    openWeb: '在浏览器中打开',
    openWebShort: '网页版',
    language: '语言',
  },
  hero: {
    title: '团队语音、聊天与通话——部署在你自己的服务器上',
    benefits: ['像 Discord 一样轻量', '一分钟搭好自己的服务器', '会议录音自动生成摘要'],
    download: '下载',
    openWeb: '在浏览器中打开',
    trust: '开源（BSL 1.1）· macOS · Windows · Linux · 网页版',
    shotAlt: 'Calab 窗口：“Команда Calab”工作区，“общий”房间中的消息、语音房间和在线成员',
  },
  why: {
    title: '为什么选择 Calab',
    items: {
      light: {
        title: '轻量',
        text: '未通话时 CPU 占用 0.05%，语音中约 7%（MacBook Air M4）。窗口隐藏时不解码视频。',
      },
      server: {
        title: '自己的服务器',
        text: '{code}，一分钟后即可使用。数据始终留在你手中。',
      },
      network: {
        title: '穿透 VPN 和防火墙',
        text: 'UDP 被封？通过 443 端口走 TURN/TLS，就像普通的 HTTPS。',
      },
      recording: {
        title: '会议录音',
        text: '转写和摘要以卡片形式发送到房间聊天中。',
      },
    },
  },
  features: {
    eyebrow: '功能',
    title: '语音、屏幕与聊天，尽在一个窗口',
    lead: '一键进入房间，直接开口交流。其他一切触手可及。',
    items: {
      voice: {
        title: '语音清晰，无回声、无噪音',
        text: '语音激活或按键说话，后台也可使用。RNNoise 降噪与 AEC3 回声消除，不戴耳机也清晰。',
        points: ['音质分级：从“低”到“极佳”', 'Opus 16–64 kbps，停顿时约 1 kbps', '断线重连无需退出房间'],
        alt: '语音房间“Переговорка”：Boris Petrov 正在发言，已打开基于 RNNoise 的降噪面板',
      },
      stream: {
        title: '屏幕共享与摄像头',
        text: '以 AV1 或硬件 H.264 共享屏幕——由显卡而不是 CPU 编码。观看者可以在共享画面上绘图和使用指示器。',
        points: ['720p、1080p 或原始分辨率', '静态屏幕仅需 20–300 kbps', '每位观看者获得与其网络匹配的画质'],
        alt: 'Vera Kim 正在共享屏幕，带有直播标记：一张带清单的“Релиз 0.2”幻灯片',
        insetAlt: '开启摄像头前的预览：背景已虚化（轻度），下方是工作区背景和通用背景',
      },
      chat: {
        title: '像 Telegram 一样好用的聊天',
        text: '每个语音房间都有自己的聊天。回复、表情回应、转发、贴纸、语音消息、带预览的文件、置顶和搜索。',
        points: ['一次转发到多个聊天', '工作区贴纸包，也支持动态贴纸', '语音消息、音乐和视频内置播放器'],
        alt: '一条转发自 Борис Петров 的消息，输入框上方显示贴纸建议',
      },
      dm: {
        title: '私信与通话',
        text: '一对一聊天，一键发起通话——可从成员菜单、个人资料或对话顶部发起。来电会响铃并发出通知。',
        points: ['通话中可开摄像头、共享屏幕', '未接和已拒绝的来电显示在消息流中', '对话归档'],
        alt: '与 Boris Petrov 的私信通话：标题栏中的通话计时和“挂断”按钮',
      },
      recording: {
        title: '会议录音与摘要',
        text: '在语音房间中开始录音——会议结束后，聊天中会收到包含摘要、音频和完整转写的卡片。转写由 GPTunneL 完成。',
        points: ['按发言搜索，点击即可跳转', '摘要列出会议主题和决定', '可以转发录音或直接回复'],
        alt: '会议录音卡片：带进度的播放按钮、包含主题和决定的摘要，以及“回复”和“完整转写”按钮',
      },
      bots: {
        title: '机器人与 API',
        text: '机器人是持有令牌的成员：在聊天中发消息、响应 /命令、在语音房间中说话。提供 TypeScript SDK，事件通过 WebSocket 或 webhook 推送。',
        link: '了解 Bot API',
      },
      mobile: {
        title: '手机上使用',
        text: '网页版自动适配屏幕：房间在侧边抽屉中，语音和按键说话在底部。可以像应用一样添加到主屏幕。',
        alt: 'iPhone 上的 Calab：“общий”房间中的消息和输入框',
      },
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
    eyebrow: '价格',
    title: 'Free、Team、Enterprise 与私有部署',
    lead: '免费开始。需要更多？选择云端的 Team 或 Enterprise，或把 Calab 部署到自己的服务器上。',
    startHere: '从这里开始',
    plans: {
      free: { name: 'Free', price: '免费', note: '适合小团队：每个房间最多 5 人' },
      team: { name: 'Team', price: '价格详询', note: '每个房间最多 50 人，视频不受限制' },
      enterprise: { name: 'Enterprise', price: '价格详询', note: '无任何限制的云服务与优先支持' },
      selfHosted: { name: 'Self-hosted', price: '自己的服务器', note: '你的基础设施，BSL 1.1 许可证' },
    },
    cta: {
      web: '网页版',
      download: '下载',
      contact: '联系我们',
      license: '许可条款',
    },
    table: {
      caption: '套餐对比',
      feature: '功能',
      details: '包含内容',
      unlimited: '不限',
      no: '无',
      yes: '有',
      rows: {
        room: '语音房间',
        members: '工作区成员',
        audio: '通话质量',
        video: '屏幕共享和摄像头',
        streams: '每个房间的屏幕共享',
        files: '文件',
        bots: '机器人',
        stickers: '贴纸包',
        support: '技术支持',
        price: '价格',
      },
      cells: {
        room: ['最多 5 人', '最多 50 人', '∞', '∞'],
        members: ['最多 50 人', '∞', '∞', '∞'],
        audio: ['最高「普通」', '任意', '任意', '任意'],
        video: ['720p，15 帧/秒', '∞', '∞', '∞'],
        streams: ['1', '∞', '∞', '∞'],
        files: ['5 GB', '1 TB', '∞', '∞'],
        bots: ['1', '20', '∞', '∞'],
        stickers: ['1', '∞', '∞', '∞'],
        support: ['—', '✓', '优先', '—'],
        price: ['免费', '详询', '详询', 'BSL 1.1；商业许可详询'],
      },
    },
    license:
      '私有部署：非商业用途免费，需在界面中保留“Powered by GPTunneL”；商业用途需要 GPTunneL 许可证。Calab 的每个版本在发布四年后转为 Apache License 2.0。',
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
      recording: {
        q: '什么是会议录音？音频会发送到哪里？',
        a: '工作区只需在设置中用一个代码连接一次 GPTunneL。之后除访客外的任何成员都可以在语音房间中开始录音，录音由服务器完成。会议结束后，音频会发送到 GPTunneL 进行转写，房间聊天中会收到包含摘要和完整转写的卡片；音频作为卡片附件保存 30 天。可以在房间设置中禁止录音。',
      },
      traffic: {
        q: 'Calab 需要多少流量？',
        a: '语音每位发言者 16–64 kbps（默认 32），静音时约 1 kbps。共享静态屏幕 20–300 kbps，1080p 上限 2 Mbps。服务器会根据每位观看者的网络状况发送相应画质。',
      },
      updates: {
        q: '应用如何更新？',
        a: '桌面版在启动时自动更新。macOS 版已签名并经 Apple 公证；Windows 版暂未签名，SmartScreen 可能会发出警告。网页版始终是最新的。',
      },
      whatsNew: {
        q: '0.8.0 有哪些新功能？',
        a: '私信中的一对一通话、音质分级、像 Telegram 一样的已读标记、Enterprise 套餐，以及可以回复会议录音卡片。完整列表请见{changelog}。',
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
      roomLimit: {
        q: '房间里已有 5 人时，第 6 个人会怎样？',
        a: 'Free 方案下，一个语音房间同时最多容纳 5 人。第 6 个人无法加入，会看到关于方案限制的提示，以及升级到 Team 的选项。',
      },
      license: {
        q: '如何获取 self-hosted 的商业许可？',
        a: '请发送邮件至 {email}，介绍你的公司和使用场景，我们会将条款发给你。',
      },
      enterprise: {
        q: 'Enterprise 与 Team、私有部署有什么区别？',
        a: 'Team 是有限制的云服务：每个房间最多 50 人、最多 1 TB 文件、20 个机器人，并提供技术支持。Enterprise 同样在云端，但完全不设限制，如同私有部署，并提供优先技术支持。Self-hosted 是按 BSL 1.1 许可部署在你自己基础设施上的 Calab，同样不设限制。Team 和 Enterprise 的价格请发邮件至 {email} 咨询。',
      },
      buyTeam: {
        q: '如何购买 Team？',
        a: '请发送邮件至 {email}——我们通常会在一天内为你开通。',
      },
    },
    changelogLink: '更新日志',
  },
  footer: {
    navLabel: '文档',
    license: '许可证',
    commercial: '商业许可',
    security: '安全',
    trademarks: '商标',
    bots: 'Bot API',
  },
  bots: {
    meta: {
      title: 'Calab 机器人 — 通过 API 实现聊天、语音和命令',
      description:
        'Calab 机器人是持有令牌的成员：读写聊天、响应 /命令、通过 WebSocket 或 webhook 接收事件，并通过 LiveKit 在语音房间中说话。',
    },
    eyebrow: '机器人',
    title: '机器人和其他成员一样',
    lead: '在工作区设置中创建机器人并为其分配角色——它使用与应用相同的 API：聊天、命令、语音。',
    cards: {
      chat: {
        title: '聊天',
        text: '读写消息、回复、添加表情回应、发送文件和贴纸、发送私信。事件通过 WebSocket 实时到达。',
      },
      voice: {
        title: '语音',
        text: '通过 LiveKit 加入语音房间：听到参与者并自己说话——文字转语音、回声、音乐。支持 Node、Python 和 Go。',
      },
      commands: {
        title: '命令',
        text: '注册 /命令——输入“/”时输入框会提示。/cmd 消息会连同解析好的参数送达机器人。',
      },
      webhook: {
        title: 'Webhook',
        text: '无需保持连接：事件以带 HMAC 签名的 POST 请求送达，失败时自动重试。',
      },
    },
    rights: '权限来自角色，与普通成员相同：机器人只能看到允许它进入的房间。',
    codeTitle: 'TypeScript 回声机器人',
    codeCaption: '此示例及另外三个示例（语音回声、文字转语音、Python 监听器）位于 {examples}。',
    ctaTitle: '5 分钟创建第一个机器人',
    ctaText: '令牌、REST、事件、webhook、语音、限制和错误码——详见文档。',
    docs: 'Bot API 文档',
    docsLang: '（英文）',
    sdk: 'GitHub 上的 SDK',
  },
};

export default zh;

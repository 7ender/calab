import type { Dict } from './ru';

// Simplified Chinese (zh-CN).
const zh: Dict = {
  meta: {
    title: 'Calab — 团队语音、聊天、会议与任务，部署在你自己的服务器上',
    description:
      '语音房间、像 Telegram 一样的聊天、带会议的日历、任务看板、笔记和访客链接，全部部署在你自己的服务器上。会议录音附带摘要，支持机器人和 API，可穿透 VPN。支持 macOS、Windows、Linux 和浏览器。',
    ogAlt: 'Calab 应用窗口：规划会中共享的幻灯片和参会者的摄像头',
  },
  header: {
    skip: '跳到正文',
    home: 'Calab — 返回顶部',
    navLabel: '页面导航',
    nav: {
      features: '功能',
      calendar: '日历',
      boards: '看板',
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
    badge: '1.1 新功能：任务看板和查找时间',
    title: '整个团队，一个窗口',
    lead: '语音房间、聊天、会议和任务，都在你自己的服务器上。像 Discord 一样轻量，像 Telegram 一样好用。',
    download: '下载',
    openWeb: '在浏览器中打开',
    trust: '开源（BSL 1.1）· macOS · Windows · Linux · 网页版',
    shotAlt: '规划会中的 Calab 窗口：舞台上是“1.1 版本”幻灯片，下方是参会者的摄像头，左侧是工作区的房间',
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
    voice: {
      eyebrow: '语音与视频',
      title: '进入房间，直接开口',
      text: '语音房间随时开放：一键即可加入对话。摄像头、屏幕共享和一对一通话都在同一处，无需另发链接或另装应用。',
      points: [
        'RNNoise 降噪和 AEC3 回声消除——不戴耳机也清晰',
        '按键说话和语音激活，后台也可用',
        '以 AV1 或硬件 H.264 共享屏幕，可在画面上指示和绘图',
        '摄像头支持背景虚化或替换图片',
        '会议录音，转写和摘要直接发到聊天',
      ],
      alt: '私信中的一对一通话：标题栏显示“通话 · 00:00”和“挂断”按钮，底部是语音面板',
    },
    chat: {
      eyebrow: '聊天',
      title: '像 Telegram 一样好用的聊天',
      text: '每个房间都有自己的聊天：回复、表情回应、转发、贴纸、语音消息、带预览的文件、置顶和搜索。已读标记一如既往。',
      points: ['一次转发到多个聊天', '工作区贴纸包', '语音消息、音乐和视频内置播放器', '提及、按房间设置通知、工作区搜索'],
      alt: '“综合”房间：带表情回应的设计稿、对它的回复、一张贴纸和在线成员',
    },
    calendar: {
      eyebrow: '日历与会议',
      title: '会议就在对话旁边',
      text: '日历内置在应用中：当天的会议、邀请、参会者的回复、带“前往”按钮的会议房间，以及提前 15 分钟的提醒。',
      cards: {
        invites: { title: '.ics 邀请', text: '带 invite.ics 的邮件会把会议加入 Apple、Google、Outlook 或 Yandex 日历。外部参会者通过链接回复，并以访客身份加入。' },
        find: { title: '查找时间', text: '同事的忙闲列、共同空闲时段和最近的可选时间——点击即可创建会议。' },
        caldav: { title: 'CalDAV', text: '连接 Yandex、iCloud、Fastmail 或 Nextcloud：你的忙碌时间会被计入，Calab 的会议也会自动出现在其中。' },
      },
      alt: '日视图：并排的会议、红色的“现在”线，以及带参会者的“发布规划会”会议卡片',
      findAlt: '为四个人“查找时间”：忙闲列、绿色的共同空闲时段和选中的时间',
    },
    boards: {
      eyebrow: '任务看板',
      title: '任务就在对话旁边',
      text: '看板、列表和时间线，Linear 风格——无需再用另一个服务。可以从任意消息创建任务，任务链接在聊天中展开为卡片。',
      points: ['状态、优先级、标签、里程碑和截止日期', '多名负责人、子任务和关联', '像聊天一样的评论：表情回应、贴纸、语音消息', '筛选、保存的视图和快捷键'],
      free: 'Free 版含 3 个看板，Team 和 Enterprise 不限数量。',
      alt: '“产品”看板视图：各状态列中的任务卡片，带标签、截止日期和负责人',
      timelineAlt: '看板时间线：按日期排列的任务条、“今天”线和“1.1 版本”里程碑',
      taskAlt: '任务面板：子任务、“阻塞”关联、历史记录和像聊天一样的评论',
    },
    notes: {
      eyebrow: '笔记',
      title: '存放重要内容的私人书架',
      text: '最多 20 个书架，名称和表情由你决定——就像 Telegram 的“收藏夹”，但可以有多个。书架只有你自己能看到。',
      points: ['把消息拖到书架上，或直接转发', '从访达或资源管理器把文件拖到书架上', '像普通聊天一样置顶和搜索'],
      alt: '笔记：“想法”“链接”“发布相关”书架，以及打开的书架中的笔记和一条转发的消息',
    },
    guests: {
      eyebrow: '访客',
      title: '访客无需注册——经你批准即可',
      text: '访客链接直达房间：访客输入名字就能加入对话。需要把关？开启审批：组织者会看到“请求加入”，点击“放行”即可。',
      points: ['访客只能看到自己的房间', '可按房间或按链接设置审批', '组织者会听到提示音并看到等待人数'],
      alt: '访客界面：“正在等待组织者批准…”，显示房间名称和“取消”按钮',
    },
    bots: {
      eyebrow: '机器人与 SDK',
      title: '机器人也是普通成员',
      text: '机器人使用与应用相同的 API：在聊天中发消息、响应 /命令、在语音房间中说话，并按权限处理看板。',
      points: ['TypeScript SDK，提供 Node 和 Python 示例', '事件通过 WebSocket 或带 HMAC 签名的 webhook 推送', '和人一样通过角色授权'],
      link: '了解 Bot API',
    },
    selfhost: {
      eyebrow: '自托管与安全',
      title: '你的服务器，你的数据',
      text: '一条命令即可把 Calab 部署到你的 Linux 服务器上，不依赖任何外部服务。',
      step: '第 {n} 步：',
      steps: {
        server: { title: '部署服务器', text: '一台装有 Docker 并绑定域名的 Linux 主机。一条命令，一分钟内即可运行，Let’s Encrypt 证书自动签发。' },
        install: { title: '安装应用', text: 'macOS、Windows 或 Linux。也可以直接在浏览器中打开 Calab，无需安装。' },
        invite: { title: '邀请团队', text: '发送邀请链接。只参加一次会议的访客无需注册账号。' },
      },
      security: {
        tls: { title: '传输加密', text: 'API 和信令使用 TLS，语音和视频使用 DTLS-SRTP。' },
        data: { title: '数据归你所有', text: '消息、文件和录音只保存在你的服务器上。' },
        network: { title: '可穿透 VPN', text: 'UDP 被封？通过 443 端口走 TURN/TLS，对网络来说就是普通 HTTPS。' },
        roles: { title: '权限覆盖一切', text: '角色以及每个房间、每个看板的权限都由服务器校验。' },
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
        boards: '任务看板',
        calendar: '日历',
        caldav: 'CalDAV',
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
        boards: ['3', '∞', '∞', '∞'],
        calendar: ['✓', '✓', '✓', '✓'],
        caldav: ['✓', '✓', '✓', '✓'],
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
        q: '1.1 有哪些新功能？',
        a: '任务看板——看板、列表和时间线，可从消息创建任务，评论像聊天一样；按同事忙闲“查找时间”，以及通过 CalDAV 连接外部日历。1.0 带来了日历与会议、笔记和访客审批。完整列表见{changelog}。',
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

import type { Dict } from './ru';

const es: Dict = {
  meta: {
    title: 'Calab — voz, chat y llamadas para tu equipo, en tu propio servidor',
    description:
      'Salas de voz, chat, llamadas y pantalla compartida para tu equipo, en tu propio servidor. Grabaciones de reuniones con transcripción y resumen, bots y API, funciona detrás de VPN y cortafuegos. macOS, Windows, Linux y navegador.',
    ogAlt: 'Calab — ventana de la aplicación con el chat de un equipo',
  },
  header: {
    skip: 'Ir al contenido',
    home: 'Calab — volver arriba',
    navLabel: 'Secciones',
    nav: {
      features: 'Funciones',
      how: 'Cómo empezar',
      download: 'Descargar',
      pricing: 'Precios',
      faq: 'Preguntas',
      bots: 'Bots',
    },
    openWeb: 'Abrir en el navegador',
    openWebShort: 'Versión web',
    language: 'Idioma',
  },
  hero: {
    title: 'Voz, chat y llamadas para tu equipo, en tu propio servidor',
    benefits: ['Ligero como Discord', 'Tu servidor en un minuto', 'Reuniones grabadas con resumen'],
    download: 'Descargar',
    openWeb: 'Abrir en el navegador',
    trust: 'Código abierto (BSL 1.1) · macOS · Windows · Linux · web',
    shotAlt: 'Ventana de Calab: el espacio «Команда Calab», la sala «общий» con mensajes, una sala de voz y miembros conectados',
  },
  why: {
    title: 'Por qué Calab',
    items: {
      light: {
        title: 'Ligero',
        text: '0,05 % de CPU fuera de llamada y ≈ 7 % en voz (MacBook Air M4). Con la ventana oculta no decodifica vídeo.',
      },
      server: {
        title: 'Tu propio servidor',
        text: '{code} y en un minuto todo funciona. Tus datos se quedan contigo.',
      },
      network: {
        title: 'Detrás de VPN y cortafuegos',
        text: '¿UDP bloqueado? TURN/TLS por el puerto 443, como HTTPS normal.',
      },
      recording: {
        title: 'Grabación de reuniones',
        text: 'La transcripción y el resumen llegan como tarjeta al chat de la sala.',
      },
    },
  },
  features: {
    eyebrow: 'Funciones',
    title: 'Voz, pantalla y chat en una sola ventana',
    lead: 'Un clic para entrar en una sala y ya estás hablando. Todo lo demás, a mano.',
    items: {
      voice: {
        title: 'Voz sin eco ni ruido',
        text: 'Activación por voz o pulsar para hablar, también en segundo plano. Supresión de ruido RNNoise y cancelación de eco AEC3: se oye limpio incluso sin auriculares.',
        points: ['Niveles de calidad de Baja a Excelente', 'Opus a 16–64 kbit/s, unos 1 kbit/s en silencio', 'Reconexión sin salir de la sala'],
        alt: 'Sala de voz «Переговорка»: habla Boris Petrov, está abierto el panel de supresión de ruido con RNNoise',
      },
      stream: {
        title: 'Pantalla compartida y cámara',
        text: 'Comparte pantalla en AV1 o H.264 por hardware: codifica la tarjeta gráfica, no el procesador. Los espectadores pueden dibujar y señalar sobre la pantalla.',
        points: ['720p, 1080p o resolución original', 'Una pantalla estática, 20–300 kbit/s', 'Cada espectador recibe la calidad de su conexión'],
        alt: 'Vera Kim comparte pantalla con la etiqueta EN VIVO: una diapositiva «Релиз 0.2» con una lista de comprobación',
        insetAlt: 'Prueba de la cámara antes de activarla: fondo desenfocado («Suave»), debajo los fondos del espacio y los comunes',
      },
      chat: {
        title: 'Chat como en Telegram',
        text: 'Cada sala de voz tiene su chat. Respuestas, reacciones, reenvío, stickers, mensajes de voz, archivos con vista previa, fijados y búsqueda.',
        points: ['Reenvío a varios chats a la vez', 'Paquetes de stickers del espacio, también animados', 'Mensajes de voz, música y vídeo con reproductor integrado'],
        alt: 'El canal con un mensaje reenviado de Борис Петров y el campo de texto',
      },
      dm: {
        title: 'Mensajes directos y llamadas',
        text: 'Conversaciones uno a uno y llamadas con un clic: desde el menú del miembro, su perfil o la cabecera del chat. Las llamadas entrantes suenan y avisan.',
        points: ['Cámara y pantalla compartida en la llamada', 'Llamadas perdidas y rechazadas en el chat', 'Archivo de conversaciones'],
        alt: 'Una llamada en mensajes directos con Boris Petrov: el contador de la llamada y el botón «Colgar» en la cabecera',
      },
      recording: {
        title: 'Reuniones grabadas con resumen',
        text: 'Graba en una sala de voz: al terminar llega al chat una tarjeta con el resumen, el audio y la transcripción completa. La transcripción la hace GPTunneL.',
        points: ['Búsqueda por frases y salto con un clic', 'Temas y decisiones de la reunión en el resumen', 'Puedes reenviar la grabación o responder a ella'],
        alt: 'Tarjeta de una reunión grabada: botón de reproducción con progreso, resumen con temas y decisiones, botones «Responder» y «Transcripción completa»',
      },
      bots: {
        title: 'Bots y API',
        text: 'Un bot es un miembro con token: escribe en el chat, responde a /comandos y habla en salas de voz. SDK en TypeScript, eventos por WebSocket o webhook.',
        link: 'Más sobre la Bot API',
      },
      mobile: {
        title: 'En el teléfono',
        text: 'La versión web se adapta a la pantalla: salas en un panel lateral, voz y pulsar para hablar abajo. Se instala en la pantalla de inicio como una app.',
        alt: 'Calab en un iPhone: la sala «общий» con mensajes y el campo de texto',
      },
    },
  },
  how: {
    eyebrow: 'Cómo funciona',
    title: 'Tres pasos hasta tu primera llamada',
    step: 'Paso {n}.',
    steps: {
      server: {
        title: 'Monta el servidor',
        text: 'Un host Linux con Docker y un dominio. Un solo comando y en un minuto todo funciona; los certificados de Let’s Encrypt se emiten solos.',
      },
      install: {
        title: 'Instala la aplicación',
        text: 'macOS, Windows o Linux. O simplemente abre Calab en el navegador, sin instalar nada.',
      },
      invite: {
        title: 'Invita a tu equipo',
        text: 'Envía un enlace de invitación. Los invitados a una sola reunión no necesitan cuenta.',
      },
    },
  },
  downloads: {
    eyebrow: 'Descargar',
    title: 'Aplicación para todas las plataformas',
    lead: 'Cliente en Electron: atajos globales, pulsar para hablar en segundo plano y compartir cualquier ventana.',
    primary: {
      mac: 'Descargar para macOS',
      win: 'Descargar para Windows',
      linux: 'Descargar para Linux',
      macIntel: 'Intel',
      macIntelLabel: 'Descargar para Mac con procesador Intel',
      linuxDebLabel: 'Descargar el paquete .deb para Linux',
      version: 'Versión',
      allVersions: 'Todas las versiones',
    },
    platforms: {
      mac: {
        format: 'DMG, macOS 12 o posterior',
        note: 'Firmada con Developer ID y notarizada por Apple: se abre sin advertencias.',
      },
      win: {
        format: 'Instalador .exe, Windows 10 y 11',
        note: 'La compilación aún no está firmada: en el primer inicio SmartScreen mostrará «Editor desconocido» → «Más información» → «Ejecutar de todas formas».',
        file: 'Descargar .exe',
      },
      linux: {
        format: 'x64',
        note: 'Antes de ejecutar el AppImage, hazlo ejecutable: {code}.',
      },
    },
    web: 'O abre la {link} en Chrome, Edge, Safari o Firefox.',
    webLink: 'versión web',
    whatsNew: 'Novedades:',
    changelog: 'Registro de cambios',
    releases: 'Versiones en GitHub',
  },
  pricing: {
    eyebrow: 'Precios',
    title: 'Free, Team, Enterprise o tu propio servidor',
    lead: 'Empieza gratis. ¿Necesitas más? Team o Enterprise en la nube, o Calab en tu propio servidor.',
    startHere: 'Empieza aquí',
    plans: {
      free: { name: 'Free', price: 'Gratis', note: 'Para equipos pequeños: hasta 5 personas por sala' },
      team: { name: 'Team', price: 'Bajo consulta', note: 'Hasta 50 personas por sala, vídeo sin límites' },
      enterprise: { name: 'Enterprise', price: 'Bajo consulta', note: 'Nube sin límites y soporte prioritario' },
      selfHosted: { name: 'Self-hosted', price: 'Tu servidor', note: 'Tu infraestructura, licencia BSL 1.1' },
    },
    cta: {
      web: 'Versión web',
      download: 'Descargar',
      contact: 'Contactar',
      license: 'Condiciones de la licencia',
    },
    table: {
      caption: 'Comparación de planes',
      feature: 'Función',
      details: 'Qué incluye',
      unlimited: 'sin límite',
      no: 'no',
      yes: 'sí',
      rows: {
        room: 'Sala de voz',
        members: 'Miembros del espacio',
        audio: 'Calidad de audio',
        video: 'Pantalla compartida y cámara',
        streams: 'Pantallas compartidas por sala',
        files: 'Archivos',
        bots: 'Bots',
        stickers: 'Paquetes de stickers',
        support: 'Soporte',
        price: 'Precio',
      },
      cells: {
        room: ['hasta 5', 'hasta 50', '∞', '∞'],
        members: ['hasta 50', '∞', '∞', '∞'],
        audio: ['hasta Normal', 'cualquiera', 'cualquiera', 'cualquiera'],
        video: ['720p, 15 fps', '∞', '∞', '∞'],
        streams: ['1', '∞', '∞', '∞'],
        files: ['5 GB', '1 TB', '∞', '∞'],
        bots: ['1', '20', '∞', '∞'],
        stickers: ['1', '∞', '∞', '∞'],
        support: ['—', '✓', 'prioritario', '—'],
        price: ['gratis', 'bajo consulta', 'bajo consulta', 'BSL 1.1; comercial bajo consulta'],
      },
    },
    license:
      'Self-hosted: gratis para uso no comercial, con «Powered by GPTunneL» en la interfaz; uso comercial con licencia de GPTunneL. Cada versión de Calab pasa a la Apache License 2.0 cuatro años después de su publicación.',
    licenseLink: 'Texto de la licencia',
  },
  faq: {
    eyebrow: 'Preguntas',
    title: 'Lo esencial, en breve',
    items: {
      server: {
        q: '¿Qué necesito para tener mi propio servidor?',
        a: 'Un host Linux con Docker, una IP pública y un dominio. Puertos abiertos: 80 y 443 (TCP y UDP), 7881/TCP y 7882/UDP. Para un equipo de hasta 30 personas, unos 4 vCPU y 8 GB de memoria; la cifra exacta depende de cuántas pantallas se compartan a la vez.',
      },
      recording: {
        q: '¿Qué es la grabación de reuniones y adónde va el audio?',
        a: 'El espacio se conecta una vez a GPTunneL con un código en los ajustes. Después, cualquier miembro salvo los invitados puede grabar en una sala de voz; la grabación la hace el servidor. Al terminar, el audio se envía a GPTunneL para transcribirlo y al chat de la sala llega una tarjeta con el resumen y la transcripción completa; el audio se guarda como adjunto de la tarjeta 30 días. La grabación se puede desactivar en los ajustes de la sala.',
      },
      traffic: {
        q: '¿Cuántos datos consume Calab?',
        a: 'La voz, 16–64 kbit/s por persona que habla (32 por defecto) y alrededor de 1 kbit/s en silencio. Compartir una pantalla estática, 20–300 kbit/s, con un máximo de 2 Mbit/s en 1080p. El servidor envía a cada espectador la calidad que admite su conexión.',
      },
      updates: {
        q: '¿Cómo se actualiza la aplicación?',
        a: 'La aplicación de escritorio se actualiza sola al iniciarse. La versión para macOS está firmada y notarizada por Apple; la de Windows aún no está firmada, por lo que SmartScreen puede mostrar una advertencia. La versión web siempre está al día.',
      },
      whatsNew: {
        q: '¿Qué hay de nuevo en 0.8.0?',
        a: 'Llamadas uno a uno en mensajes directos, niveles de calidad de audio, confirmaciones de lectura como en Telegram, el plan Enterprise y respuestas a la tarjeta de una reunión grabada. La lista completa, en el {changelog}.',
      },
      security: {
        q: '¿Cómo se protege la conexión?',
        a: 'La API y la señalización van por TLS; la voz y el vídeo, por DTLS-SRTP. Los mensajes y archivos se guardan solo en tu servidor. Todavía no hay cifrado de extremo a extremo: el audio y el vídeo pasan por tu servidor de medios.',
      },
      firewall: {
        q: '¿Funciona con VPN y cortafuegos corporativos?',
        a: 'Sí. Si UDP no está disponible, el cliente pasa a TCP y luego a TURN/TLS por el puerto 443; para la red es tráfico HTTPS normal.',
      },
      limits: {
        q: '¿Qué límites tiene la versión actual?',
        a: 'Está pensada para 20–30 personas conectadas a la vez y hasta tres pantallas compartidas por sala. El escalado horizontal está previsto.',
      },
      roomLimit: {
        q: '¿Qué pasa cuando una 6.ª persona intenta entrar a la sala?',
        a: 'En el plan Free, una sala de voz admite hasta 5 personas a la vez. La sexta persona no podrá entrar: verá un aviso sobre el límite del plan y la opción de pasar a Team.',
      },
      license: {
        q: '¿Cómo obtengo una licencia comercial para self-hosted?',
        a: 'Escríbenos a {email}, cuéntanos sobre tu empresa y tu caso de uso, y te enviaremos las condiciones.',
      },
      enterprise: {
        q: '¿En qué se diferencia Enterprise de Team y de self-hosted?',
        a: 'Team es la nube con límites: hasta 50 personas por sala, hasta 1 TB de archivos, 20 bots y soporte. Enterprise también es la nube, pero sin ningún límite, como tu propio servidor, y con soporte prioritario. Self-hosted es Calab en tu propia infraestructura con la licencia BSL 1.1, sin límites. El precio de Team y Enterprise es bajo consulta en {email}.',
      },
      buyTeam: {
        q: '¿Cómo compro Team?',
        a: 'Escríbenos a {email}: normalmente activamos el plan en un día.',
      },
    },
    changelogLink: 'registro de cambios',
  },
  footer: {
    navLabel: 'Documentos',
    license: 'Licencia',
    commercial: 'Licencia comercial',
    security: 'Seguridad',
    trademarks: 'Marcas registradas',
    bots: 'Bot API',
  },
  bots: {
    meta: {
      title: 'Bots de Calab — chat, voz y comandos por API',
      description:
        'Los bots de Calab son miembros con un token: leen y escriben en el chat, responden a /comandos, reciben eventos por WebSocket o webhook y hablan en salas de voz a través de LiveKit.',
    },
    eyebrow: 'Bots',
    title: 'Un bot es un miembro más',
    lead: 'Crea un bot en los ajustes del espacio de trabajo y dale un rol: funciona con la misma API que la app — chat, comandos y voz.',
    cards: {
      chat: {
        title: 'Chat',
        text: 'Lee y escribe mensajes, responde, reacciona, envía archivos y stickers y escribe mensajes directos. Eventos en tiempo real por WebSocket.',
      },
      voice: {
        title: 'Voz',
        text: 'Entra en una sala de voz a través de LiveKit: oye a los participantes y habla — texto a voz, eco, música. En Node, Python o Go.',
      },
      commands: {
        title: 'Comandos',
        text: 'Registra /comandos: el editor los sugiere al escribir «/». Un mensaje /cmd llega al bot con sus argumentos.',
      },
      webhook: {
        title: 'Webhook',
        text: 'Sin conexión abierta: los eventos llegan como POST firmados con HMAC y se reintentan si fallan.',
      },
    },
    rights: 'Los permisos vienen de los roles, como para las personas: un bot solo ve las salas a las que tiene acceso.',
    codeTitle: 'Un bot de eco en TypeScript',
    codeCaption: 'Este y tres ejemplos más — eco de voz, texto a voz y un oyente en Python — están en {examples}.',
    ctaTitle: 'Tu primer bot en 5 minutos',
    ctaText: 'Token, REST, eventos, webhook, voz, límites y códigos de error — en la documentación.',
    docs: 'Documentación de la Bot API',
    docsLang: '(en inglés)',
    sdk: 'SDK en GitHub',
  },
};

export default es;

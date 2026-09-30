import type { Dict } from './ru';

const es: Dict = {
  meta: {
    title: 'Calab — voz, chat, reuniones y tareas para tu equipo, en tu propio servidor',
    description:
      'Salas de voz, chat como Telegram, calendario con reuniones, tableros de tareas, notas y enlaces para invitados, en tu propio servidor. Grabaciones de reuniones con resumen, bots y API, funciona detrás de VPN. macOS, Windows, Linux y navegador.',
    ogAlt: 'Calab — la ventana de la aplicación en una reunión de planificación: una diapositiva compartida y las cámaras de los participantes',
  },
  header: {
    skip: 'Ir al contenido',
    home: 'Calab — volver arriba',
    navLabel: 'Secciones',
    nav: {
      features: 'Funciones',
      calendar: 'Calendario',
      boards: 'Tableros',
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
    badge: 'Novedad en la 1.1: tableros de tareas y Buscar hora',
    title: 'Todo el equipo en una ventana',
    lead: 'Salas de voz, chat, reuniones y tareas en tu propio servidor. Ligero como Discord, cómodo como Telegram.',
    download: 'Descargar',
    openWeb: 'Abrir en el navegador',
    trust: 'Código abierto (BSL 1.1) · macOS · Windows · Linux · web',
    shotAlt: 'La ventana de Calab durante una reunión de planificación: la diapositiva «Versión 1.1» en el escenario, las cámaras de los participantes debajo y las salas del espacio a la izquierda',
  },
  why: {
    title: 'Por qué Calab',
    items: {
      light: {
        title: 'Ligero',
        text: '0,05 % de CPU sin llamada, ≈ 7 % en voz (MacBook Air M4). Con la ventana oculta no se decodifica vídeo.',
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
        title: 'Grabaciones de reuniones',
        text: 'La transcripción y el resumen llegan como tarjeta al chat de la sala.',
      },
    },
  },
  features: {
    voice: {
      eyebrow: 'Voz y vídeo',
      title: 'Entra en la sala y habla',
      text: 'Las salas de voz están siempre abiertas: un clic y ya estás en la conversación. Cámaras, pantalla compartida y llamadas uno a uno, en el mismo sitio, sin enlaces ni aplicaciones aparte.',
      points: [
        'Supresión de ruido RNNoise y cancelación de eco AEC3: se oye limpio incluso sin auriculares',
        'Pulsar para hablar y activación por voz, también en segundo plano',
        'Pantalla compartida en AV1 o H.264 por hardware, con puntero y dibujo encima',
        'Cámara con fondo desenfocado o una imagen',
        'Grabación de reuniones con transcripción y resumen en el chat',
      ],
      alt: 'Una llamada uno a uno en mensajes directos: «Llamada · 00:00» y el botón «Colgar» en la cabecera, el panel de voz abajo',
    },
    chat: {
      eyebrow: 'Chat',
      title: 'Un chat como Telegram',
      text: 'Cada sala tiene su propio chat: respuestas, reacciones, reenvíos, stickers, mensajes de voz, archivos con vista previa, mensajes fijados y búsqueda. Marcas de lectura, como estás acostumbrado.',
      points: ['Reenvía a varios chats a la vez', 'Paquetes de stickers del espacio', 'Mensajes de voz, música y vídeo con reproductor integrado', 'Menciones, notificaciones por sala, búsqueda en el espacio'],
      alt: 'La sala «general»: una maqueta con reacciones, una respuesta, un sticker y los miembros conectados',
    },
    calendar: {
      eyebrow: 'Calendario y reuniones',
      title: 'Reuniones donde está la conversación',
      text: 'El calendario está dentro de la aplicación: tu día de reuniones, invitaciones, respuestas de los asistentes, la sala de la reunión con el botón «Ir» y recordatorios 15 minutos antes.',
      cards: {
        invites: { title: 'Invitaciones .ics', text: 'Un correo con invite.ics añade la reunión al calendario de Apple, Google, Outlook o Yandex. Los asistentes externos responden por enlace y entran como invitados.' },
        find: { title: 'Buscar hora', text: 'Columnas de ocupación de tus compañeros, huecos libres comunes y las franjas más cercanas: un clic crea la reunión.' },
        caldav: { title: 'CalDAV', text: 'Conecta Yandex, iCloud, Fastmail o Nextcloud: tu ocupación cuenta y las reuniones de Calab aparecen allí solas.' },
      },
      alt: 'La vista del día: reuniones en paralelo, la línea roja de «ahora» y la tarjeta de la reunión «Planificación de la versión» con asistentes',
      findAlt: '«Buscar hora» para cuatro personas: columnas de ocupación, el hueco libre común en verde y la franja elegida',
    },
    boards: {
      eyebrow: 'Tableros de tareas',
      title: 'Las tareas junto a la conversación',
      text: 'Kanban, lista y cronograma al estilo de Linear, sin otro servicio. Crea una tarea desde cualquier mensaje; su enlace se despliega como tarjeta en el chat.',
      points: ['Estados, prioridades, etiquetas, hitos y fechas límite', 'Varios responsables, subtareas y relaciones', 'Comentarios como en el chat: reacciones, stickers, mensajes de voz', 'Filtros, vistas guardadas y atajos de teclado'],
      free: 'Free incluye 3 tableros; Team y Enterprise, sin límite.',
      alt: 'El tablero «Producto» en kanban: columnas de estado con tarjetas, etiquetas, fechas y responsables',
      timelineAlt: 'El cronograma del tablero: barras de tareas por fecha, la línea de «hoy» y el hito «Versión 1.1»',
      taskAlt: 'El panel de la tarea: subtareas, una relación «bloquea», historial y comentarios como en el chat',
    },
    notes: {
      eyebrow: 'Notas',
      title: 'Estantes privados para lo importante',
      text: 'Hasta 20 estantes con tus nombres y emoji, como «Mensajes guardados» de Telegram, pero varios. Solo tú ves cada estante.',
      points: ['Arrastra un mensaje a un estante o reenvíalo', 'Suelta archivos desde Finder o el Explorador', 'Mensajes fijados y búsqueda, como en cualquier chat'],
      alt: 'Notas: los estantes «Ideas», «Enlaces» y «Para la versión» y un estante abierto con notas y un mensaje reenviado',
    },
    guests: {
      eyebrow: 'Invitados',
      title: 'Invitados sin registro, con tu permiso',
      text: 'Un enlace de invitado lleva directo a la sala: el invitado escribe su nombre y entra en la conversación. ¿Quieres control? Activa la aprobación: el organizador ve «pide entrar» y pulsa «Dejar entrar».',
      points: ['El invitado solo ve su sala', 'Aprobación por sala o por enlace', 'Un sonido y un contador de espera para el organizador'],
      alt: 'La pantalla del invitado: «Esperando la aprobación del organizador…» con el nombre de la sala y el botón «Cancelar»',
    },
    bots: {
      eyebrow: 'Bots y SDK',
      title: 'Un bot es un miembro más',
      text: 'Un bot usa la misma API que la aplicación: escribe en el chat, responde a /comandos, habla en las salas de voz y trabaja con los tableros según sus permisos.',
      points: ['SDK en TypeScript, ejemplos en Node y Python', 'Eventos por WebSocket o webhook firmado con HMAC', 'Permisos por roles, como las personas'],
      link: 'Más sobre la Bot API',
    },
    selfhost: {
      eyebrow: 'Servidor propio y seguridad',
      title: 'Tu servidor, tus datos',
      text: 'Calab se instala en tu servidor Linux con un comando y no depende de servicios externos.',
      step: 'Paso {n}.',
      steps: {
        server: { title: 'Prepara el servidor', text: 'Un host Linux con Docker y un dominio. Un comando y en un minuto está funcionando; los certificados de Let’s Encrypt se emiten solos.' },
        install: { title: 'Instala la aplicación', text: 'macOS, Windows o Linux. O simplemente abre Calab en el navegador, sin instalar nada.' },
        invite: { title: 'Invita a tu equipo', text: 'Envía un enlace de invitación. Los invitados a una sola reunión no necesitan cuenta.' },
      },
      security: {
        tls: { title: 'Cifrado en tránsito', text: 'La API y la señalización van por TLS; la voz y el vídeo, por DTLS-SRTP.' },
        data: { title: 'Tus datos, contigo', text: 'Mensajes, archivos y grabaciones se guardan solo en tu servidor.' },
        network: { title: 'Funciona tras una VPN', text: '¿UDP bloqueado? TURN/TLS por el 443: para la red es HTTPS normal.' },
        roles: { title: 'Permisos para todo', text: 'Los roles y los permisos por sala y por tablero los comprueba el servidor.' },
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
        boards: 'Tableros de tareas',
        calendar: 'Calendario',
        caldav: 'CalDAV',
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
        boards: ['3', '∞', '∞', '∞'],
        calendar: ['✓', '✓', '✓', '✓'],
        caldav: ['✓', '✓', '✓', '✓'],
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
        q: '¿Qué hay de nuevo en la 1.1?',
        a: 'Tableros de tareas: kanban, lista y cronograma, tareas desde mensajes y comentarios como en el chat; «Buscar hora» según la ocupación de tus compañeros y calendario externo por CalDAV. La 1.0 trajo el calendario y las reuniones, las Notas y la aprobación de invitados. La lista completa está en el {changelog}.',
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

import type { Dict } from './ru';

const es: Dict = {
  meta: {
    title: 'Calab — voz, chat y pantalla compartida para equipos',
    description:
      'Salas de voz, chat y pantalla compartida para tu equipo, en tu propio servidor. Sin eco ni ruido, pantalla compartida en AV1 desde 20 kbit/s, funciona detrás de VPN y cortafuegos. macOS, Windows, Linux y navegador.',
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
      pricing: 'Licencia',
      faq: 'Preguntas',
    },
    openWeb: 'Abrir en el navegador',
    openWebShort: 'Versión web',
    language: 'Idioma',
  },
  hero: {
    tagline: 'Salas de voz, chat y pantalla compartida para tu equipo, en tu propio servidor',
    download: 'Descargar',
    openWeb: 'Abrir en el navegador',
    platforms: 'macOS, Windows, Linux y navegador',
    shotAlt: 'Ventana de Calab: el espacio «Equipo Calab», la sala «general» con mensajes y miembros en línea',
  },
  features: {
    eyebrow: 'Funciones',
    title: 'Voz, pantalla y chat en una sola ventana',
    lead: 'Entra en una sala con un clic y empieza a hablar. Todo lo demás, a mano.',
    items: {
      voice: {
        title: 'Voz sin eco ni ruido',
        text: 'Activación por voz o pulsar para hablar. Supresión de ruido RNNoise y cancelación de eco AEC3: se oye limpio incluso sin auriculares. Opus a 16–64 kbit/s y alrededor de 1 kbit/s en silencio.',
        alt: 'Elección del modo de micrófono: activación por voz o pulsar para hablar',
      },
      stream: {
        title: 'Pantalla compartida en AV1',
        text: '720p, 1080p o resolución original. El texto y el código estáticos ocupan 20–300 kbit/s, así que la pantalla se lee bien incluso con datos móviles. Hasta tres pantallas compartidas por sala.',
        alt: 'Vera Kim comparte su pantalla con la etiqueta LIVE: una diapositiva «Versión 0.2» con una lista de tareas',
      },
      chat: {
        title: 'Un chat como el de Telegram',
        text: 'Archivos, reacciones, respuestas, mensajes fijados, menciones y búsqueda. Cada sala de voz tiene su propio chat.',
        alt: 'Un mensaje con la vista previa de un enlace y, debajo, un mensaje con una imagen',
      },
      dm: {
        title: 'Mensajes directos',
        text: 'Conversaciones uno a uno con cualquier miembro de tus espacios compartidos, en su propia sección con contador de no leídos. El mismo chat: archivos, reacciones, mensajes fijados.',
        alt: 'La lista de mensajes directos y una conversación con Borís Petrov: la lista de comprobación del lanzamiento y una invitación a una llamada',
      },
      mobile: {
        title: 'En el teléfono',
        text: 'La versión web se adapta a la pantalla del teléfono: salas y conversaciones en un panel lateral, voz y push-to-talk en la parte inferior. Se instala en la pantalla de inicio como una app.',
        alt: 'Calab en un iPhone: el canal «общий» con mensajes y el campo de texto',
      },
      roles: {
        title: 'Roles, permisos y enlaces de invitado',
        text: 'Permisos por espacio y por sala. Un invitado entra con un enlace, sin cuenta, y solo ve su sala.',
        alt: 'Enlace para invitados: acceso sin cuenta, permisos del invitado y un enlace activo calab.ru/r/…',
      },
      network: {
        title: 'Funciona detrás de VPN y cortafuegos',
        text: 'Si UDP está bloqueado, el audio y el vídeo pasan a TCP y luego a TURN/TLS por el puerto 443, que parece tráfico HTTPS normal. Si se corta la conexión, se recupera sin salir de la sala.',
        order: 'Orden de conexión',
      },
      server: {
        title: 'Tu servidor, tus datos',
        text: 'Caddy, LiveKit, una API en Go, Postgres y Valkey en un solo Docker Compose. Los mensajes, archivos y medios no salen de tu infraestructura. Kubernetes es el siguiente paso.',
      },
    },
    inspiredTitle: 'Qué nos inspiró',
    inspired: {
      discord: 'La estructura: espacios, salas de voz y de texto, roles.',
      telegram: 'Chats cómodos: respuestas, reacciones, archivos, búsqueda.',
      zoom: 'Una conexión estable: se adapta a tu red y se reconecta sin sacarte de la sala.',
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
    eyebrow: 'Licencia',
    title: 'Gratis si no es para un negocio',
    lead: 'El código fuente es abierto. El uso comercial requiere una licencia de GPTunneL.',
    free: {
      name: 'Uso no comercial',
      price: 'Gratis',
      items: [
        'Proyectos personales',
        'Organizaciones sin ánimo de lucro, educación e investigación',
        'Evaluación en cualquier empresa durante un máximo de 30 días',
        'Condición: «Powered by GPTunneL» en la interfaz',
      ],
      cta: 'Descargar',
    },
    commercial: {
      name: 'Licencia comercial',
      price: 'Bajo consulta',
      items: [
        'Uso en tu negocio y para tus clientes',
        'Autoalojado en tus servidores o alojamiento gestionado',
        'Condiciones según el tamaño del equipo',
      ],
      cta: 'Escribirnos',
    },
    license:
      'Calab se distribuye bajo la Business Source License 1.1. Cada versión pasa a la Apache License 2.0 cuatro años después de su publicación.',
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
      traffic: {
        q: '¿Cuántos datos consume Calab?',
        a: 'La voz, 16–64 kbit/s por persona que habla (32 por defecto) y alrededor de 1 kbit/s en silencio. Compartir una pantalla estática, 20–300 kbit/s, con un máximo de 2 Mbit/s en 1080p. El servidor envía a cada espectador la calidad que admite su conexión.',
      },
      updates: {
        q: '¿Cómo se actualiza la aplicación?',
        a: 'La aplicación de escritorio se actualiza sola al iniciarse. La versión para macOS está firmada y notarizada por Apple; la de Windows aún no está firmada, por lo que SmartScreen puede mostrar una advertencia. La versión web siempre está al día.',
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
      license: {
        q: '¿Cómo obtengo una licencia comercial?',
        a: 'Escríbenos a {email}, cuéntanos sobre tu empresa y tu caso de uso, y te enviaremos las condiciones.',
      },
    },
  },
  footer: {
    navLabel: 'Documentos',
    license: 'Licencia',
    commercial: 'Licencia comercial',
    security: 'Seguridad',
    trademarks: 'Marcas registradas',
  },
};

export default es;

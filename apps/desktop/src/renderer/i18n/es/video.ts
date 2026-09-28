import type { enVideo } from '../en/video';
import type { DictShape } from '../types';

/**
 * Spanish UI strings — webcam in voice rooms (docs/09 #41–43, ADR-0022). Same rules as en: flat
 * dotted keys, `{param}` placeholders, short, verb-first, no exclamation marks (docs/08).
 */
export const esVideo: DictShape<typeof enVideo> = {
  // voice panel / self panel
  'video.camera': 'Cámara',
  'video.on': 'Activar cámara',
  'video.off': 'Desactivar cámara',
  'video.starting': 'Iniciando cámara…',
  'video.options': 'Opciones de cámara',
  'video.device': 'Cámara',
  'video.check': 'Probar cámara',
  'video.previewRow': 'Vista previa de la cámara',
  'video.checkShort': 'Probar',
  'video.noPermission': 'No tienes permiso para usar la cámara en esta sala',
  'video.roomOff': 'Las cámaras están desactivadas en esta sala',
  'video.full': 'Cámara — ya hay {n} de {max} en esta sala',
  'video.noDevices': 'No se encontraron cámaras',
  'shell.streamBtn': 'Compartir',
  'shell.noiseBtn': 'Ruido',

  // preview sheet
  'video.preview.title': 'Comprueba tu cámara',
  'video.preview.text': 'Así te verán los demás. La vista previa está reflejada.',
  'video.preview.loading': 'Iniciando cámara…',
  'video.preview.enable': 'Activar cámara',
  'video.preview.done': 'Listo',

  // toasts
  'video.limit': 'Límite de cámaras alcanzado',
  'video.forbidden': 'No tienes permiso para usar la cámara en esta sala',
  'video.fallback': 'La cámara seleccionada no está disponible — usando la cámara predeterminada',
  'video.lost': 'La cámara se desconectó',
  'video.cpu': 'Cámara cambiada a 360p: procesador sobrecargado',
  'video.stop.limit': 'Cámara desactivada: se alcanzó el límite de cámaras de la sala',
  'video.stop.moderator': 'Un moderador desactivó tu cámara',
  'video.stop.other': 'Cámara desactivada por el servidor',
  'video.rejoin': 'Conexión restablecida — vuelve a activar tu cámara',
  'video.movedOff': '{text}; cámara desactivada — vuelve a activarla',

  // tiles
  'video.of': 'Cámara: {name}',
  'video.you': '{name} (tú)',
  'video.hidden': 'Video oculto',
  'video.saved': 'Video en pausa — el ahorro de datos está activado',
  'video.more': '{n} más',
  'video.expand': 'Ampliar video',
  'video.focus': 'Enfocar',
  'video.unfocus': 'Volver a la cuadrícula',
  'video.unfocusHint': 'O pulsa Esc, o haz clic en la miniatura otra vez',
  'video.pinned': 'Fijado en foco',
  'video.showChat': 'Mostrar chat',
  'video.close': 'Ocultar video',
  'video.grid': 'Videos de los miembros',
  'video.stateOn': 'Cámara activada',

  // member menu / settings
  'video.hide': 'Ocultar video',
  'video.stopMember': 'Desactivar cámara',
  'video.stoppedMember': 'Cámara de {name} desactivada',
  'video.saveTraffic': 'Ahorro de datos',
  'video.saveTrafficHint': 'Recibir solo el video de quien habla, hasta 360p',
  'video.screenCard': 'Compartir pantalla',
  'video.streamCodec': 'Códec de la transmisión',
  'video.codecAuto': 'Automático (según el hardware)',
  'video.codecAv1': 'Calidad del texto (AV1)',
  'video.codecH264': 'Compatibilidad (H.264)',
  'video.codecAutoHint': 'Codifica la tarjeta gráfica si puede: menos carga de CPU para ti y para quien mira',
  'video.codecAv1Hint': 'Texto más nítido, más carga de CPU para ti y para quien mira sin decodificador por hardware',
  'video.codecH264Hint': 'Perfil básico de H.264: cualquier espectador lo reproduce, pero lo codifica el procesador, con más carga que «Automático»',
  'video.card': 'Cámara',
  'voiceUi.collapsePanel': 'Contraer panel',
  'voiceUi.expandPanel': 'Expandir panel',
  'video.deviceHint': 'Se aplica de inmediato, incluso durante una llamada',

  // room / workspace settings, permissions
  'perm.VIDEO': 'Usar cámara',
  'media.cameraLimit': 'Cámaras a la vez',
  'media.cameraLimitHint': '0 — las cámaras están desactivadas en la sala',

  // errors (lib/media/errors.ts)
  'mediaErr.camera.permission': 'Cámara no disponible — comprueba el permiso',
  'mediaErr.camera.permissionWeb': 'Tu navegador bloqueó la cámara — permítela con el icono en la barra de direcciones',
  'mediaErr.camera.notFound': 'No se encontró ninguna cámara — conecta una o elige otra',
  'mediaErr.camera.busy': 'La cámara está en uso por otra aplicación',
  'mediaErr.camera.unsupported': 'La cámara no es compatible con este dispositivo',
  'mediaErr.camera.generic': 'No se pudo activar la cámara',
  'mediaErr.camera.publish': 'No se pudo compartir tu video — inténtalo de nuevo',

  // noise suppression popover (docs/09 #12), voice room chat without voice (docs/09 #14)
  'noise.about': 'Activa la supresión de ruido: aplaude mientras hablas — los demás solo oirán tu voz',
  'noise.checkHint': '3 segundos de grabación y luego te escucharás',
  'noise.recording': 'Habla — grabando…',
  'noise.playing': 'Así te oyen los demás',
  'noise.poweredBy': 'Con tecnología RNNoise',
  'noise.learnMore': 'Más información',
  'voicePreview.notInVoice': 'No estás en voz',
  'voicePreview.join': 'Unirse a la voz',
  'voicePreview.openChat': 'Abrir chat',
  // room «…» menu and meeting recording (docs/09 #30)
  'roomMenu.more': 'Más',
  'roomMenu.moreOf': 'Acciones de «{name}»',
  'roomMenu.invite': 'Invitar a la sala',
  'roomMenu.record': 'Grabar reunión',
  'rec.badge': 'REC',
  'rec.label': 'Grabando',
  'rec.on': 'Grabación en curso',
  'rec.time': 'Grabación en curso, {time}',
  'rec.by': 'Grabación iniciada por {name}',
  'rec.menu.title': 'Grabando · {time}',
  'rec.menu.by': 'Iniciada por {name}',
  'rec.menu.confirm': '¿Detener la grabación?',
  'rec.menu.confirmAction': 'Detener',
} as const;

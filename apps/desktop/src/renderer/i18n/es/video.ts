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
} as const;

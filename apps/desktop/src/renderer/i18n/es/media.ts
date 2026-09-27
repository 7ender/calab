import type { ruMedia } from '../ru/media';
import type { DictShape } from '../types';

/** Spanish UI strings — audio / video player in the chat (docs/08). Same keys as ru/media.ts. */
export const esMedia: DictShape<typeof ruMedia> = {
  'media.audio': 'Audio «{name}»',
  'media.video': 'Vídeo «{name}»',
  'media.play': 'Reproducir',
  'media.pause': 'Pausa',
  'media.seek': 'Buscar',
  'media.position': '{pos} de {total}',
  'media.speed': 'Velocidad: {rate}',
  'media.fullscreen': 'Pantalla completa',
  'media.pip': 'Imagen en imagen',
  'media.nowPlaying': 'Reproduciendo',
  'media.jump': 'Mostrar mensaje',
  'media.close': 'Cerrar reproductor',
  'media.error': 'No se puede reproducir',
};

import type { enEcho } from '../en/echo';
import type { DictShape } from '../types';

/** Spanish UI strings — echo on loudspeakers (docs/02, docs/08). Same keys as en/echo.ts. */
export const esEcho: DictShape<typeof enEcho> = {
  'echo.risk': 'Parece que la otra persona se escucha a sí misma. Ponte los auriculares o cambia al modo «Altavoces»',
  'echo.riskAction': 'Activar «Altavoces»',
  'echo.riskAuto': 'Parece que la otra persona se escucha a sí misma. Mientras otros hablan, tu micrófono sonará más bajo (modo «Automático»)',
  'echo.riskSpeakers': 'Parece que la otra persona todavía se escucha a sí misma. Ponte los auriculares o baja el volumen de los altavoces',
  'echo.card': 'Altavoces y eco',
  'echo.mode': 'Cómo escuchas',
  'echo.modeHeadphones': 'Auriculares',
  'echo.modeSpeakers': 'Altavoces',
  'echo.modeAuto': 'Automático',
  'echo.hintHeadphones': 'Tu micrófono siempre suena al máximo. Si otros empiezan a escucharse a sí mismos, Calab te avisará.',
  'echo.hintSpeakers': 'Mientras otros hablan, tu micrófono suena más bajo, para que su voz no vuelva a ellos desde tus altavoces. Aun así puedes interrumpir.',
  'echo.hintAuto': 'Tu micrófono baja mientras otros hablan, pero solo cuando Calab detecta que se escuchan a sí mismos.',
  'echo.check': 'Prueba de eco',
  'echo.checkHint': 'Tus altavoces reproducirán un sonido suave durante 3 segundos mientras lo escuchamos por el micrófono',
  'echo.checkBtn': 'Probar',
  'echo.checkInCall': 'No disponible durante una llamada',
  'echo.none': 'No se detectó eco.',
  'echo.weak': 'Eco leve: otros pueden escucharse a sí mismos de vez en cuando. Baja el volumen de los altavoces o elige «Automático».',
  'echo.strong': 'Eco fuerte: otros se escucharán a sí mismos. Ponte los auriculares o elige «Altavoces».',
  'echo.failed': 'No se pudo comprobar: {error}',
} as const;

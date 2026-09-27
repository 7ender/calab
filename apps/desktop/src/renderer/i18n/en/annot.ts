import type { ruAnnot } from '../ru/annot';
import type { DictShape } from '../types';

/** English UI strings — laser pointer and pen over a stream (ADR-0028). */
export const enAnnot: DictShape<typeof ruAnnot> = {
  'annot.tools': 'Draw on the stream',
  'annot.pointer': 'Pointer',
  'annot.pen': 'Pen',
  'annot.color': 'Color',
  'annot.clear': 'Clear',
  'annot.clearAll': 'Erase viewers’ drawings',
  'annot.allowViewers': 'Viewers can draw',
  'annot.color.red': 'Red',
  'annot.color.yellow': 'Yellow',
  'annot.color.green': 'Green',
  'annot.color.blue': 'Blue',
  'annot.color.purple': 'Purple',
  'annot.color.white': 'White',
};

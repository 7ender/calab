import { describe, expect, it } from 'vitest';
import { normalize, queryWords, searchSettings, type SettingsEntry } from './settingsSearch';

const sections = [
  { id: 'voice', label: 'Голос и устройства' },
  { id: 'appearance', label: 'Внешний вид' },
  { id: 'hotkeys', label: 'Горячие клавиши' },
];
const e = (section: string, n: number, label: string, hint?: string): SettingsEntry => ({ key: `${section}:${n}`, section, label, hint });
const entries = [
  e('voice', 0, 'Микрофон'),
  e('voice', 1, 'Порог активации', 'Микрофон включается, когда уровень выше порога'),
  e('voice', 2, 'Клавиша push-to-talk'),
  e('appearance', 0, 'Тема'),
  e('hotkeys', 0, 'Клавиша push-to-talk'),
  e('hotkeys', 1, 'Быстрый переход'),
  e('hotkeys', 2, 'Быстрый переход'),
];

describe('normalize', () => {
  it('folds case, ё and spaces', () => {
    expect(normalize('  Ещё   ЁЛКА ')).toBe('еще елка');
    expect(queryWords(' push  TO ')).toEqual(['push', 'to']);
  });
});

describe('searchSettings', () => {
  it('returns nothing for an empty query', () => {
    expect(searchSettings(sections, entries, '   ')).toEqual([]);
  });

  it('finds rows by label, keeping section order', () => {
    const r = searchSettings(sections, entries, 'клавиша');
    expect(r.map((g) => g.section)).toEqual(['voice', 'hotkeys']);
    expect(r[0]?.rows.map((x) => x.key)).toEqual(['voice:2']);
  });

  it('matches a section title and marks it', () => {
    const r = searchSettings(sections, entries, 'горячие');
    expect(r).toEqual([{ section: 'hotkeys', sectionHit: true, rows: [] }]);
  });

  it('lists label matches before hint-only matches', () => {
    const r = searchSettings(sections, entries, 'микрофон');
    expect(r[0]?.rows.map((x) => x.key)).toEqual(['voice:0', 'voice:1']);
  });

  it('requires every word', () => {
    expect(searchSettings(sections, entries, 'порог тема')).toEqual([]);
    expect(searchSettings(sections, entries, 'порог микро')[0]?.rows.map((x) => x.key)).toEqual(['voice:1']);
  });

  it('dedupes equal labels in a section', () => {
    expect(searchSettings(sections, entries, 'быстрый')[0]?.rows).toHaveLength(1);
  });

  it('is ё-insensitive', () => {
    expect(searchSettings([{ id: 'x', label: 'Ещё' }], [], 'еще')).toHaveLength(1);
  });
});

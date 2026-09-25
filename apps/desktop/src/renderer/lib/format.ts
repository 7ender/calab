import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';

export const toDate = (ts: Timestamp | undefined): Date => (ts ? timestampDate(ts) : new Date());

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeStyle: 'short' });

export const fmtTime = (d: Date): string => timeFmt.format(d);
export const fmtFull = (d: Date): string => fullFmt.format(d);

export function fmtDay(d: Date): string {
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return dayFmt.format(d);
}

export function fmtStamp(d: Date): string {
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `сегодня в ${fmtTime(d)}`;
  return `${dayFmt.format(d)} ${fmtTime(d)}`;
}

export function fmtSize(bytes: number | bigint): string {
  const b = Number(bytes);
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} МБ`;
  return `${(b / 1024 ** 3).toFixed(2)} ГБ`;
}

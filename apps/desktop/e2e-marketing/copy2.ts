import type { Short } from './copy';

/**
 * Calab 2.0 marketing scenes (landing-v2.spec.ts): boards 2.0 (categories, checklists, webhook),
 * workspace identity (SSO, «Войти через Calab»). Only data lives here, the UI text comes from the app's
 * dictionaries. Tasks refer to the titles of copy.ts (`board.tasks`) by index.
 */
export interface Copy2 {
  /** Board categories: name + the extra boards in it (name, key, emoji); the first category also holds the main board. */
  categories: { dev: string; marketing: string };
  platformBoard: string;
  contentBoard: string;
  /** Two named checklists of the opened task (index 4 of board.tasks): 4 + 3 items, 3 done in the first. */
  checklists: [{ title: string; items: string[]; done: number }, { title: string; items: string[]; done: number }];
  /** Progress on other cards: task index → [title, items, done]. */
  cardLists: Record<number, { title: string; items: string[]; done: number }>;
  webhookUrl: string;
  sso: { name: string; issuerHost: string; clientId: string };
  consent: { app: string; redirect: string };
}

const ru: Copy2 = {
  categories: { dev: 'Разработка', marketing: 'Маркетинг' },
  platformBoard: 'Платформа',
  contentBoard: 'Контент-план',
  checklists: [
    { title: 'Воспроизведение', items: ['Windows 11 + внешние колонки', 'macOS, встроенные динамики', 'Гарнитура Bluetooth', 'Две вкладки браузера'], done: 3 },
    { title: 'Перед релизом', items: ['Регресс звонка на трёх ОС', 'Заметка в changelog', 'Проверить на слабом ноутбуке'], done: 0 },
  ],
  cardLists: {
    5: { title: 'План', items: ['Рабочие часы в профиле', 'Учёт часового пояса', 'Подсказка в календаре', 'Тесты на границах дня', 'Документация'], done: 2 },
    7: { title: 'Проверки', items: ['Миграция', 'Права чтения', 'Права записи', 'Тесты', 'Ревью', 'Релизная заметка'], done: 5 },
    8: { title: 'Кадры', items: ['Чат', 'Звонок', 'Доски', 'Календарь'], done: 1 },
  },
  webhookUrl: 'https://hooks.example.com/calab/nordlight',
  sso: { name: 'Нордлайт SSO', issuerHost: 'id.nordlight.example', clientId: 'calab-nordlight' },
  consent: { app: 'Нордлайт Портал', redirect: 'https://portal.nordlight.example/auth/callback' },
};

const en: Copy2 = {
  categories: { dev: 'Engineering', marketing: 'Marketing' },
  platformBoard: 'Platform',
  contentBoard: 'Content plan',
  checklists: [
    { title: 'Reproduction', items: ['Windows 11 + external speakers', 'macOS, built-in speakers', 'Bluetooth headset', 'Two browser tabs'], done: 3 },
    { title: 'Before release', items: ['Call regression on three OSes', 'Changelog note', 'Check on a low-end laptop'], done: 0 },
  ],
  cardLists: {
    5: { title: 'Plan', items: ['Working hours in profile', 'Time zone handling', 'Calendar hint', 'Day-boundary tests', 'Docs'], done: 2 },
    7: { title: 'Checks', items: ['Migration', 'Read permissions', 'Write permissions', 'Tests', 'Review', 'Release note'], done: 5 },
    8: { title: 'Frames', items: ['Chat', 'Call', 'Boards', 'Calendar'], done: 1 },
  },
  webhookUrl: 'https://hooks.example.com/calab/northlight',
  sso: { name: 'Northlight SSO', issuerHost: 'id.northlight.example', clientId: 'calab-northlight' },
  consent: { app: 'Northlight Portal', redirect: 'https://portal.northlight.example/auth/callback' },
};

const es: Copy2 = {
  categories: { dev: 'Desarrollo', marketing: 'Marketing' },
  platformBoard: 'Plataforma',
  contentBoard: 'Plan de contenido',
  checklists: [
    { title: 'Reproducción', items: ['Windows 11 + altavoces externos', 'macOS, altavoces integrados', 'Auriculares Bluetooth', 'Dos pestañas del navegador'], done: 3 },
    { title: 'Antes del lanzamiento', items: ['Regresión de llamadas en tres SO', 'Nota en el changelog', 'Probar en un portátil modesto'], done: 0 },
  ],
  cardLists: {
    5: { title: 'Plan', items: ['Horario laboral en el perfil', 'Zonas horarias', 'Pista en el calendario', 'Pruebas de límites del día', 'Documentación'], done: 2 },
    7: { title: 'Comprobaciones', items: ['Migración', 'Permisos de lectura', 'Permisos de escritura', 'Pruebas', 'Revisión', 'Nota de versión'], done: 5 },
    8: { title: 'Capturas', items: ['Chat', 'Llamada', 'Tableros', 'Calendario'], done: 1 },
  },
  webhookUrl: 'https://hooks.example.com/calab/nortelux',
  sso: { name: 'Nortelux SSO', issuerHost: 'id.nortelux.example', clientId: 'calab-nortelux' },
  consent: { app: 'Portal Nortelux', redirect: 'https://portal.nortelux.example/auth/callback' },
};

const zh: Copy2 = {
  categories: { dev: '研发', marketing: '市场' },
  platformBoard: '平台',
  contentBoard: '内容计划',
  checklists: [
    { title: '复现步骤', items: ['Windows 11 + 外接音箱', 'macOS 内置扬声器', '蓝牙耳机', '两个浏览器标签页'], done: 3 },
    { title: '发布前', items: ['三个系统上的通话回归', '更新日志条目', '在低配笔记本上验证'], done: 0 },
  ],
  cardLists: {
    5: { title: '计划', items: ['资料中的工作时间', '时区处理', '日历提示', '跨日边界测试', '文档'], done: 2 },
    7: { title: '检查项', items: ['迁移', '读取权限', '写入权限', '测试', '评审', '发布说明'], done: 5 },
    8: { title: '画面', items: ['聊天', '通话', '看板', '日历'], done: 1 },
  },
  webhookUrl: 'https://hooks.example.com/calab/beiguang',
  sso: { name: '北光 SSO', issuerHost: 'id.beiguang.example', clientId: 'calab-beiguang' },
  consent: { app: '北光门户', redirect: 'https://portal.beiguang.example/auth/callback' },
};

export const COPY2: Record<Short, Copy2> = { ru, en, es, zh };

/**
 * A compact emoji set for the picker (no dependency: ~400 common emoji in 8 groups).
 * Rendered with the system emoji font (Apple Color Emoji on macOS).
 */
import type { MessageKey } from '../../i18n';

export interface EmojiGroup {
  id: string;
  /** i18n key of the group title. */
  label: MessageKey;
  icon: string;
  list: string[];
}

const split = (s: string): string[] => s.trim().split(/\s+/u);

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '🙏'];

// 🫡 (U+1FAE1) is left out: Chromium on macOS draws its Apple Color Emoji glyph cut off at the
// right edge (review 2 «emoji picker right column clipped»), whatever box it sits in.
export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    id: 'smileys',
    label: 'emoji.cat.smileys',
    icon: '😀',
    list: split(`😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒
      😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🫢 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦
      😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👻 💀 ☠️ 👽 🤖 💩 😺 😸 😹 😻 😼 😽 🙀 😿 😾`),
  },
  {
    id: 'people',
    label: 'emoji.cat.people',
    icon: '👋',
    list: split(`👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💪 🦾
      🧠 👀 👁️ 👅 👄 🫦 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 🧑‍💻 👩‍💻 👨‍💻 🧑‍🔧 🧑‍🎨 🧑‍🚀 🥷 🦸 🧙 🧚 💃 🕺 🚶 🏃`),
  },
  {
    id: 'nature',
    label: 'emoji.cat.nature',
    icon: '🐶',
    list: split(`🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍
      🦎 🐙 🦑 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦒 🐪 🦘 🐕 🐈 🐓 🦃 🦜 🕊️ 🐇 🦔 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍁 🍂 🍄 🌷 🌹
      🌺 🌸 🌼 🌻 🌞 🌝 🌚 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ 🌊 💧`),
  },
  {
    id: 'food',
    label: 'emoji.cat.food',
    icon: '🍕',
    list: split(`🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥬 🥦 🧄 🧅 🥐 🥯 🍞 🥖 🧀 🥚 🍳 🥞 🧇
      🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪
      🥜 🍯 🥛 ☕ 🍵 🧃 🥤 🧋 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾 🧊`),
  },
  {
    id: 'activity',
    label: 'emoji.cat.activity',
    icon: '⚽',
    list: split(`⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🥊 🥋 ⛳ 🏹 🎣 🤿 🎿 🛷 ⛸️ 🏂 🏋️ 🤸 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🎭 🎨
      🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🧩 🎉 🎊 🎈 🎁 🎀`),
  },
  {
    id: 'travel',
    label: 'emoji.cat.travel',
    icon: '🚗',
    list: split(`🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🚲 🛴 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊
      🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🚢 ⚓ ⛽ 🚧 🚦 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ 🏠
      🏡 🏢 🏬 🏥 🏦 🏨 🏫 ⛪ 🕌 🌅 🌄 🌠 🎇 🎆 🌇 🌆 🏙️ 🌃 🌌 🌉 🌁`),
  },
  {
    id: 'objects',
    label: 'emoji.cat.objects',
    icon: '💡',
    list: split(`⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙️ ⏱️ ⏰ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🧯 💸 💵 💰 💳 💎
      ⚖️ 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🛡️ 🔮 📿 🧿 💈 🔭 🔬 🩺 💊 💉 🧬 🦠 🧪 🌡️ 🧹 🧺 🧻 🚽 🛁 🔑 🗝️ 🚪 🛋️
      🛏️ 🧸 🖼️ 🛍️ 🛒 🎁 ✉️ 📩 📨 📧 📦 📫 📮 📜 📃 📄 📑 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗
      📘 📙 📚 📖 🔖 🔗 📎 🖇️ 📐 📏 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓`),
  },
  {
    id: 'symbols',
    label: 'emoji.cat.symbols',
    icon: '❤️',
    list: split(`❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☯️ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 📴 📳
      🈶 🆚 💮 🉐 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰
      ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🛗 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 ⚧️ 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒
      🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢 #️⃣ *️⃣ ▶️ ⏸️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ ⏫ ⏬ ◀️ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️
      ↕️ ↔️ ↪️ ↩️ ⤴️ ⤵️ 🔀 🔁 🔂 🔄 🔃 🎵 🎶 ➕ ➖ ➗ ✖️ ♾️ 💲 💱 ™️ ©️ ®️ 〰️ ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪
      🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾ ◽ ◼️ ◻️ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🟫 🔈 🔇 🔉 🔊 🔔 🔕 📣 📢 💬 💭 🗯️ ♠️ ♣️ ♥️ ♦️ 🃏 🎴 🀄`),
  },
];

/** Russian (and a few English) search words for the most used emoji. */
const KEYWORDS: Record<string, string> = {
  '😀': 'улыбка smile радость happy grin',
  '😂': 'смех слёзы lol ржу laugh joy',
  '🤣': 'смех катаюсь rofl',
  '😊': 'улыбка румянец',
  '😍': 'любовь влюблён глаза сердца',
  '🥰': 'любовь сердечки',
  '😘': 'поцелуй kiss',
  '😎': 'круто очки cool',
  '🤔': 'думаю хмм think',
  '😢': 'грусть слеза sad',
  '😭': 'плачу рыдаю cry',
  '😡': 'злость гнев angry',
  '😱': 'ужас шок крик',
  '😴': 'сон сплю sleep',
  '🙄': 'закатываю глаза',
  '😅': 'пот неловко',
  '😉': 'подмигиваю wink',
  '🥳': 'праздник вечеринка party',
  '🤯': 'взрыв мозга',
  '😬': 'неловко',
  '👍': 'лайк да ок класс like yes thumbs thumbsup',
  '👎': 'дизлайк нет no',
  '👏': 'аплодисменты браво хлопаю clap',
  '🙏': 'спасибо пожалуйста молюсь please thanks',
  '👌': 'ок окей ok',
  '✌️': 'мир победа',
  '🤝': 'рукопожатие договорились deal',
  '💪': 'сила мышцы strong',
  '👋': 'привет пока hello bye',
  '🙌': 'ура hooray',
  '👀': 'глаза смотрю look',
  '🤷': 'не знаю пожимаю',
  '🤦': 'фейспалм facepalm',
  '❤️': 'сердце любовь love heart',
  '💔': 'разбитое сердце',
  '🔥': 'огонь fire круто',
  '✨': 'искры блеск',
  '⭐': 'звезда star',
  '🎉': 'праздник поздравляю хлопушка party tada',
  '🎂': 'торт день рождения cake birthday',
  '🎁': 'подарок gift',
  '✅': 'готово галочка done',
  '❌': 'крест нет отмена',
  '⚠️': 'внимание предупреждение warning',
  '💯': 'сто сотка',
  '🚀': 'ракета релиз ship launch',
  '💡': 'идея лампочка idea',
  '🐛': 'баг жук bug',
  '☕': 'кофе coffee',
  '🍕': 'пицца pizza',
  '🍺': 'пиво beer',
  '💻': 'ноутбук компьютер laptop',
  '📌': 'закреп булавка pin',
  '📎': 'скрепка вложение',
  '🔗': 'ссылка link',
  '📅': 'календарь дата',
  '⏰': 'будильник время',
  '🤖': 'робот бот robot',
  '💩': 'какашка poop',
  '👻': 'привидение призрак ghost',
  '🎧': 'наушники headphones music',
  '🎮': 'игра геймпад game',
  '🐱': 'кот кошка cat',
  '🐶': 'собака пёс dog',
};

export function searchEmoji(q: string): string[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: string[] = [];
  for (const [e, words] of Object.entries(KEYWORDS)) if (words.split(' ').some((w) => w.startsWith(needle))) out.push(e);
  return out;
}

/** Whole-word index of KEYWORDS: the first emoji a word names («fire» → 🔥, «кот» → 🐱). */
let byWord: Map<string, string> | null = null;
export function emojiForWord(word: string): string | undefined {
  if (!byWord) {
    byWord = new Map();
    for (const [e, words] of Object.entries(KEYWORDS)) for (const w of words.split(' ')) if (w && !byWord.has(w)) byWord.set(w, e);
  }
  return byWord.get(word.toLowerCase());
}

const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** The emoji typed or pasted into a text: the picker's search accepts the emoji itself. */
export function typedEmoji(s: string): string[] {
  if (!PICTO.test(s)) return [];
  const parts =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment)
      : Array.from(s);
  return [...new Set(parts.filter((g) => PICTO.test(g)))];
}

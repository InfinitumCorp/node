// Nøde web app languages: English (the keys) and Russian.
// Choice order: what the person picked (saved on this device), then the Russian mirror, then the browser.

const RU = {
  // shell
  "Nøde — free community Wi-Fi": "Nøde — бесплатный общественный Wi-Fi",
  "Free Wi-Fi from neighbours, venues and Nøde routers. You choose what you share.": "Бесплатный Wi-Fi от соседей, заведений и роутеров Nøde. Вы решаете, чем делиться.",
  "Nøde home": "Nøde: главная",
  "Sections": "Разделы",
  "Find Wi-Fi": "Найти Wi-Fi",
  "Your data": "Ваши данные",
  "Host": "Раздавать",
  "Sign in to continue": "Войдите, чтобы продолжить",
  "Nøde uses your Cumulus ID. No separate password.": "Nøde использует ваш Cumulus ID. Отдельный пароль не нужен.",
  "Sign in with Cumulus ID": "Войти через Cumulus ID",
  "Create a Cumulus ID": "Создать Cumulus ID",
  "Creating one brings you straight back here, signed in.": "После создания вы сразу вернётесь сюда уже со входом.",
  "Free basic access. Nothing optional is ever required to get online.": "Базовый доступ бесплатный. Чтобы выйти в интернет, ничего необязательного не требуется.",
  "What we collect": "Что мы собираем",
  "Language": "Язык",

  // find
  "Free Wi-Fi near you": "Бесплатный Wi-Fi рядом",
  "Nøde hotspots are run by venues, neighbours and Nøde routers. Join them like any Wi-Fi network.": "Точки Nøde держат заведения, соседи и роутеры Nøde. Подключайтесь как к любой сети Wi-Fi.",
  "Use my location": "Определить моё место",
  "Your location is used once in your browser to search and isn't stored.": "Местоположение используется один раз для поиска и не сохраняется.",
  "Finding you…": "Определяем место…",
  "This browser can't share a location.": "Этот браузер не умеет передавать местоположение.",
  "A Nøde router reported sharing in the last 20 minutes": "Роутер Nøde сообщил о раздаче за последние 20 минут",
  "live": "в сети",
  "Network: {ssid} · about {km} km": "Сеть: {ssid} · около {km} км",
  "I'm on it": "Я подключился",
  "Connected, but no internet": "Подключился, но интернета нет",
  "Couldn't find the network": "Не нашёл сеть",
  "It asked for a password": "Сеть просит пароль",
  "Too slow to use": "Слишком медленно",
  "Reported. Thank you.": "Отправлено. Спасибо.",
  "Report a problem with this hotspot": "Сообщить о проблеме с этой точкой",
  "Report a problem…": "Сообщить о проблеме…",
  "Guests reported, last 7 days: {list}": "Гости сообщили за 7 дней: {list}",
  "{what} ({n})": "{what} ({n})",
  "Map of {n} hotspots around you, up to {km} km": "Карта: точек рядом — {n}, в радиусе {km} км",
  "{km} km": "{km} км",
  "N": "С",
  "E": "В",
  "S": "Ю",
  "W": "З",
  "No Nøde hotspots here yet. Coverage grows place by place —": "Здесь пока нет точек Nøde. Покрытие растёт шаг за шагом —",
  "host one": "откройте свою",
  "Location wasn't shared. You can still join any network named “Nøde”.": "Местоположение не передано. Вы всё равно можете подключиться к любой сети «Nøde».",
  "Thanks": "Спасибо",
  "Connected": "Подключено",

  // kinds
  "home": "дом",
  "business": "заведение",
  "relay": "ретранслятор",
  "gateway": "шлюз",
  "phone": "телефон",

  // privacy
  "What Nøde collects": "Что собирает Nøde",
  "needed": "необходимо",
  "your choice": "на ваш выбор",
  "Your data, your choices": "Ваши данные — ваш выбор",
  "Getting online never depends on these. Change them any time; nothing happens to your access.": "Доступ в интернет от этого не зависит. Меняйте в любой момент — доступ останется.",
  "Where you live (sets the starting choices the law expects)": "Где вы живёте (от этого зависят начальные настройки по закону)",
  "Licensed to partners in aggregate. Funds free access.": "Передаётся партнёрам только в обобщённом виде. Оплачивает бесплатный доступ.",
  "Saved.": "Сохранено.",
  "Delete my Nøde data": "Удалить мои данные Nøde",
  "Delete your Nøde account, choices and hotspots? This can't be undone.": "Удалить аккаунт Nøde, настройки и точки? Это нельзя отменить.",

  // purposes (titles and summaries come from the API in English)
  "Run the network": "Работа сети",
  "Your sign-in and the hotspot you're connected to, so we can let you on and keep the network safe. Never sold.": "Ваш вход и точка, к которой вы подключены, — чтобы пустить вас в сеть и защищать её. Никогда не продаётся.",
  "Network quality reports": "Отчёты о качестве сети",
  "Speed, latency and uptime of Nøde hotspots, grouped by area and hour, with small groups removed. Never tied to your account.": "Скорость, задержка и доступность точек Nøde по районам и часам, без малых групп. Никогда не связаны с вашим аккаунтом.",
  "Venue busy-hours": "Загруженность заведений",
  "How many sessions a venue had each hour, in groups of 10 or more. Venues use it to plan staffing.": "Сколько сеансов было в заведении за час, только группами от 10. Заведения планируют по ним смены.",
  "Consumer research": "Опросы",
  "Surveys you choose to answer. Each survey says who it's for before you start; you can skip any.": "Опросы, на которые вы сами решили ответить. Каждый заранее говорит, для кого он; любой можно пропустить.",
  "Campaign measurement": "Оценка рекламных кампаний",
  "Whether a campaign at a venue was seen, counted only in aggregate. No profiles, no tracking across sites.": "Видели ли кампанию в заведении — только в общих цифрах. Без профилей и слежки между сайтами.",
  "Share my connection": "Делиться моим интернетом",
  "Let Nøde guests use part of your connection within the limits you set. Uses your data allowance and battery.": "Гости Nøde пользуются частью вашего интернета в заданных вами пределах. Расходует трафик и батарею.",

  // jurisdictions
  "European Union / EEA": "Евросоюз / ЕЭЗ",
  "United Kingdom": "Великобритания",
  "California": "Калифорния",
  "United States (other)": "США (другие штаты)",
  "Russia": "Россия",
  "Everywhere else": "Другие страны",

  // host: limits
  "Guest speed cap (Mbit/s)": "Скорость для гостей (Мбит/с)",
  "Guest data per day (MB)": "Трафик гостей в день (МБ)",
  "Stop below battery (%)": "Остановить при заряде ниже (%)",
  "Stop above temperature (°C)": "Остановить при температуре выше (°C)",
  "Share during these hours (none ticked = any time):": "Раздавать в эти часы (ничего не отмечено — всегда):",
  "Guests are always on a separate network and can't reach your devices.": "Гости всегда в отдельной сети и не видят ваши устройства.",
  "This phone: battery {pct}%": "Этот телефон: заряд {pct}%",
  ", charging": ", заряжается",

  // host: routers
  "just now": "только что",
  "{n} min ago": "{n} мин назад",
  "{n} h ago": "{n} ч назад",
  "{n} days ago": "{n} дн. назад",
  "No router paired. Pair one so it follows Start/Stop and your limits from here.": "Роутер не привязан. Привяжите его, чтобы он слушался кнопок «Старт/Стоп» и ваших ограничений.",
  "checked in": "на связи",
  "Hasn't checked in yet": "Ещё не выходил на связь",
  "{n} MB shared today": "{n} МБ роздано сегодня",
  "Unpair": "Отвязать",
  "{name} paired.": "{name} привязан.",
  "Run one of these on the router now. The key is shown only once; if you lose it, unpair and pair again.": "Выполните одну из команд на роутере сейчас. Ключ показывается один раз; если потеряете — отвяжите и привяжите снова.",
  "New router (OpenWrt 23.05 or later):": "Новый роутер (OpenWrt 23.05 или новее):",
  "Router that already runs Nøde:": "Роутер, на котором уже стоит Nøde:",
  "Copy": "Копировать",
  "Copied": "Скопировано",
  "Nøde routers": "Роутеры Nøde",
  "Loading…": "Загрузка…",
  "Pair a router": "Привязать роутер",
  "Last heard from {ago}, so the hotspot is off the map. Check the router's power and internet.": "Последний раз на связи {ago}, поэтому точки нет на карте. Проверьте питание и интернет роутера.",
  "It hasn't checked in since it was paired. Run the command shown when you paired it, or unpair and pair again.": "Роутер не выходил на связь после привязки. Выполните команду, показанную при привязке, или отвяжите и привяжите снова.",
  "Not on the map right now: {state}.": "Сейчас не на карте: {state}.",
  "Guest data by day": "Трафик гостей по дням",
  "Remove this hotspot": "Удалить эту точку",
  "Remove “{name}”? Its routers stop working and its history is deleted. This can't be undone.": "Удалить «{name}»? Её роутеры перестанут работать, а история будет удалена. Это нельзя отменить.",
  "Scan to check it's working, report a problem or find more free Wi-Fi:": "Отсканируйте, чтобы проверить работу, сообщить о проблеме или найти другой бесплатный Wi-Fi:",
  "Find free Wi-Fi near you": "Найти бесплатный Wi-Fi рядом",
  "Sharing now": "Сейчас раздаёт",
  "Paused until {time}": "Пауза до {time}",
  "Not sharing right now": "Сейчас не раздаёт",
  "Its router hasn't checked in recently, so it may be off": "Роутер давно не выходил на связь — возможно, точка выключена",
  "Share link": "Поделиться ссылкой",
  "Free Wi-Fi: join “{ssid}”": "Бесплатный Wi-Fi: подключитесь к «{ssid}»",
  "Link copied": "Ссылка скопирована",
  "Any time": "В любое время",
  "Daytime 08–20": "Днём 08–20",
  "Office 09–18": "Рабочее время 09–18",
  "Evenings 18–23": "Вечером 18–23",
  "Your choices over time": "История ваших решений",
  "allowed": "разрешено",
  "declined": "отклонено",
  "No choices recorded yet, so the starting choices for where you live apply.": "Решений пока нет, поэтому действуют начальные настройки для вашего региона.",
  "You're offline. Join any Wi-Fi network named “Nøde” and try again.": "Нет подключения. Подключитесь к любой сети Wi-Fi с названием «Nøde» и попробуйте снова.",
  "Can't reach Nøde right now. Check your connection and try again.": "Не удаётся связаться с Nøde. Проверьте подключение и попробуйте снова.",
  "Print a sign": "Напечатать табличку",
  "Guest speed: not enough measurements in the last 7 days yet (needs {n} guests who share network quality).": "Скорость у гостей: за 7 дней пока мало замеров (нужно {n} гостей, разрешивших отчёты о качестве).",
  "Guests, last 7 days: about {sessions} sessions, typical download {down} Mbit/s, {ok}% connected.": "Гости за 7 дней: около {sessions} сеансов, обычная скорость {down} Мбит/с, подключились {ok}%.",
  "Paused until {time}": "Пауза до {time}",
  "Pause sharing": "Приостановить раздачу",
  "Pause…": "Пауза…",
  "for 1 hour": "на 1 час",
  "for 3 hours": "на 3 часа",
  "until 8:00 tomorrow": "до 8:00 завтра",
  "Resume now": "Возобновить",
  "Save changes": "Сохранить",
  "Saved. Paired routers switch to the new network name within 5 minutes.": "Сохранено. Привязанные роутеры сменят имя сети в течение 5 минут.",
  "Download my data": "Скачать мои данные",
  "Your data, to keep or delete": "Ваши данные: скачать или удалить",
  "Download a copy of everything Nøde holds about you, or delete it all. Deleting removes your Nøde account, your choices and any hotspots you host. Anonymous measurements were never linked to you.": "Скачайте копию всего, что Nøde хранит о вас, или удалите всё. Удаление стирает ваш аккаунт Nøde, настройки и все ваши точки. Анонимные замеры никогда не были связаны с вами.",
  "pausedUntil": "Пауза",
  "QR code: {url}": "QR-код: {url}",
  "Back to your hotspots": "К вашим точкам",
  "Print": "Печать",
  "Put it where guests can see it. It shows only the network name, never your address.": "Повесьте там, где её увидят гости. На ней только имя сети, без вашего адреса.",
  "Free Wi-Fi": "Бесплатный Wi-Fi",
  "Join the network": "Подключитесь к сети",
  "No password. Guests are on their own network, kept apart from ours.": "Без пароля. Гости в отдельной сети и не видят наши устройства.",
  "{n} MB": "{n} МБ",
  // states a router reports (firmware/openwrt/nod-limits.sh)
  "sharing": "раздаёт",
  "stopped by host": "остановлен владельцем",
  "outside sharing hours": "вне часов раздачи",
  "daily limit reached": "дневной лимит исчерпан",
  "too hot ({t}°C)": "перегрев ({t}°C)",

  // host
  "Host Nøde": "Раздавать Nøde",
  "Share part of your connection with neighbours or customers, within limits you set. It's separate from using Nøde.": "Делитесь частью интернета с соседями или гостями в своих пределах. Это отдельно от пользования Nøde.",
  "Share your connection": "Поделиться интернетом",
  "Hosting lets Nøde guests use part of your internet. It's a separate choice from using Nøde Wi-Fi.": "Раздача даёт гостям Nøde часть вашего интернета. Это отдельный выбор, не связанный с пользованием Wi-Fi Nøde.",
  "Before you turn this on:": "Прежде чем включить:",
  "it uses your data allowance and battery, and your internet plan must allow sharing. Mobile hosting works only on phones we've tested.": "это расходует трафик и батарею, а ваш тариф должен разрешать раздачу. Раздача с телефона работает только на проверенных моделях.",
  "Yes, I want to host": "Да, хочу раздавать",
  "Stop sharing now": "Остановить раздачу",
  "Stops every hotspot you run, immediately.": "Сразу останавливает все ваши точки.",
  "Your hotspots": "Ваши точки",
  "None yet. Add your home router, venue Wi-Fi or a Nøde device below.": "Пока нет. Добавьте домашний роутер, Wi-Fi заведения или устройство Nøde ниже.",
  "Add a hotspot": "Добавить точку",
  "Name people see": "Название для людей",
  "Corner Café": "Кафе на углу",
  "Wi-Fi network name": "Имя сети Wi-Fi",
  "Type": "Тип",
  "Nøde Home (household broadband)": "Nøde Дом (домашний интернет)",
  "Nøde Business (venue guest Wi-Fi)": "Nøde Бизнес (гостевой Wi-Fi заведения)",
  "Nøde Relay": "Nøde Ретранслятор",
  "Nøde Gateway": "Nøde Шлюз",
  "This phone (tested devices only)": "Этот телефон (только проверенные модели)",
  "We store your location only to about 150 m so people can find the hotspot.": "Мы храним место точки с точностью около 150 м, чтобы её могли найти.",
  "Add hotspot": "Добавить точку",
  "Stop hosting entirely": "Полностью прекратить раздачу",
  "Turns off sharing and every hotspot.": "Выключает раздачу и все точки.",
  "Stop hosting": "Прекратить раздачу",
  "Sharing": "Раздаёт",
  "Stopped": "Остановлена",
  "Stop": "Стоп",
  "Start sharing": "Начать раздачу",
  "Busy hours": "Загруженность",
  "{when}: ~{n} sessions": "{when}: ~{n} сеансов",
  "Not enough visits yet to show (hours with fewer than 10 sessions are hidden).": "Пока мало посещений (часы, где меньше 10 сеансов, скрыты).",
  "We need the hotspot's location (to about 150 m) so people can find it.": "Нужно место точки (с точностью около 150 м), чтобы её могли найти.",
  "Request failed ({status})": "Запрос не удался ({status})",

  // API errors people can hit from the web app (src/app.ts)
  "Sign in with Cumulus ID.": "Войдите через Cumulus ID.",
  "Turn on “Share my connection” first. It's separate from using Nøde.": "Сначала включите «Делиться моим интернетом». Это отдельно от пользования Nøde.",
  "No such hotspot.": "Такой точки нет.",
  "No such router.": "Такого роутера нет.",
  "Not found.": "Не найдено.",
  "Request too large.": "Слишком большой запрос.",
  "Send a JSON object.": "Неверный запрос.",
  "hours must be a list of hours 0-23.": "Часы — это список чисел от 0 до 23.",
  "Cumulus ID can't be reached right now. Try again shortly.": "Cumulus ID сейчас недоступен. Попробуйте чуть позже.",
  "A hotspot can have up to {n} routers.": "К точке можно привязать не больше {n} роутеров.",
  "{field} is required (up to {max} characters).": "Заполните поле «{field}» (не больше {max} символов).",
  "{field} must be a number from {lo} to {hi}.": "«{field}» — число от {lo} до {hi}.",
  // field names those errors use
  "name": "Название",
  "ssid": "Имя сети",
  "maxMbps": "Скорость для гостей",
  "dailyMb": "Трафик гостей в день",
  "minBatteryPct": "Минимальный заряд",
  "maxTempC": "Максимальная температура",
  "lat": "Широта",
  "lng": "Долгота",
};

/** An error message from the API, translated, including the ones with a field name or numbers in them. */
export function apiError(msg) {
  let m;
  if ((m = /^(\w+) is required \(up to (\d+) characters\)\.$/.exec(msg))) return t("{field} is required (up to {max} characters).", { field: t(m[1]), max: m[2] });
  if ((m = /^(\w+) must be a number from (-?[\d.]+) to (-?[\d.]+)\.$/.exec(msg))) return t("{field} must be a number from {lo} to {hi}.", { field: t(m[1]), lo: m[2], hi: m[3] });
  if ((m = /^A hotspot can have up to (\d+) routers\.$/.exec(msg))) return t("A hotspot can have up to {n} routers.", { n: m[1] });
  return t(msg);
}

export const DICTS = { ru: RU };
export const LANGS = [{ code: "en", name: "English" }, { code: "ru", name: "Русский" }];

function pick(mirrorLang) {
  try {
    const saved = localStorage.getItem("node:lang");
    if (saved && LANGS.some((l) => l.code === saved)) return saved;
  } catch {}
  if (mirrorLang === "ru") return "ru";
  return (navigator.languages || [navigator.language || "en"]).some((l) => String(l).toLowerCase().startsWith("ru")) ? "ru" : "en";
}

export let lang = "en";

/** Settles the language once /api/config is known, and translates the static page. */
export function setup(mirrorLang) {
  lang = pick(mirrorLang);
  document.documentElement.lang = lang;
  document.title = t("Nøde — free community Wi-Fi");
  translateTree(document);
  return lang;
}

export function choose(code) {
  try { localStorage.setItem("node:lang", code); } catch {}
  location.reload();
}

/** t("Network: {ssid}", { ssid }) — English text is the key; falls back to it. */
export function t(key, vars) {
  const s = (DICTS[lang] && DICTS[lang][key]) || key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** A state line a router reported, translated when it is one nod-limits writes. */
export function routerState(s) {
  const hot = /^too hot \((-?\d+)°C\)$/.exec(s);
  return hot ? t("too hot ({t}°C)", { t: hot[1] }) : t(s);
}

/** Elements marked data-i18n (text), data-i18n-attr="aria-label,content" (attributes) get translated. */
export function translateTree(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.textContent.trim());
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const a of el.dataset.i18nAttr.split(",")) if (el.hasAttribute(a)) el.setAttribute(a, t(el.getAttribute(a)));
  }
  for (const tpl of root.querySelectorAll("template")) translateTree(tpl.content);
}


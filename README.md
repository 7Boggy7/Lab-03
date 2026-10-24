# Lab-03: Асинхронний JavaScript — Promises, async/await і екран завантаження

Продовження тієї самої гри (цикл, корабель, кулі, зіткнення з lab-01/02). Тепер ассети
(спрайти, звук, список кімнат) приходять з мережі **без блокування потоку**: пайплайн
завантаження з прогрес-баром, спрайтшити замість векторів, Web Audio, шина подій і лобі
перед грою. Лаби 1–2 лишились у git-історії (теги `lab-01`, `lab-02`).

## Запуск

```bash
npm install
npm run dev          # http://localhost:5173
```

Потік гри: **екран завантаження → лобі → Join → гра**. У лобі вводите ім'я, обираєте кімнату
(повні кімнати неактивні) й натискаєте `Join` — цей клік і є жест, після якого створюється
`AudioContext`. Керування те саме: `W`/`↑` тяга, `A`/`D`/`←`/`→` поворот, `Пробіл` вогонь.
`Esc` під час завантаження — скасувати його.

```bash
npm run lint      # ESLint
npm run format    # Prettier
npm run bench     # sequential vs concurrent (потрібен запущений dev-сервер)
npm run assets    # перегенерувати спрайти/звуки (python3 + Pillow + numpy)
```

## Структура нового коду

| Файл | Що робить |
|---|---|
| `public/assets/manifest.json` | Список ассетів: `key`, `type` (`image`/`audio`/`json`), `url`, `bytes` (для зваженого прогресу). |
| `src/net/http.js` | `fetchOk` (fetch + перевірка `res.ok` → `HttpError`, таймаут через `AbortSignal.timeout`, зовнішній `signal` через `AbortSignal.any`) і **спільний `fetchJson`**. |
| `src/net/retry.js` | `withRetry`: exponential backoff + full jitter, переривана `sleep`, правила «що ретраїти». |
| `src/assets/loaders.js` | `loadImage` / `loadAudio` / `loadJson` — кожен приймає `{ signal }`. |
| `src/assets/loadAll.js` | `loadManifest` і `loadAll` через `Promise.all` з прогресом по кожному файлу. |
| `src/loadingScreen.js` | Екран завантаження на канвасі: прогрес-бар, список файлів, повідомлення про помилку, кнопка **Retry**. |
| `src/sprites.js` + `public/assets/*.png` | `SpriteSheet.draw()`; `atlas.json` описує кадри трьох спрайтшитів (кораблі, кулі, астероїди). |
| `src/events.js` | Шина `EventTarget` + `CustomEvent`: `fired`, `hit`, `exploded`. |
| `src/audio/audio.js` | Web Audio: `AudioContext` створюється в `start()` (з обробника кліку), підписка на шину. |
| `src/hud.js` | HUD: статистика циклу + лічильники подій зі шини. |
| `src/lobby/lobby.js` | `class Lobby extends EventTarget` — опитування `/api/rooms`, вибір кімнати, `join`. Без DOM. |
| `src/lobby/lobbyView.js` | DOM лобі — окремий модуль, слухає події `Lobby`. |
| `src/faults.js` | Навмисні збої `?fail=…` для галереї збоїв (у звичайному запуску нічого не робить). |
| `server/mock-api.js` | Vite-плагін: `GET /api/rooms` (дані з `server/rooms.json`) і `?delay=`/`?status=` для експериментів. У lab-04 його замінить справжній сервер. |
| `puzzles/` | Виконувані головоломки (`/puzzles/` у dev-сервері). |

## Пайплайн ассетів

**Три стани проміса.** `loadAll` повертає `pending`-проміс, який стає `fulfilled` (усі ассети
в об'єкті `{ atlas, ships, fire, … }`) або `rejected` (перша ж фатальна помилка). `main.js`
робить `await loadAssets()` — **гра й лобі не створюються, доки цей проміс не виконався**.

**`fetch` не кидає помилку на 404/500** — він відхиляється лише на мережевих збоях. Тому всі
loader'и йдуть через `fetchOk`, який сам перевіряє `res.ok` і кидає `HttpError(status)`.
`fetchJson` = `fetchOk` + `res.json()`; `loadImage` і `loadAudio` беруть `fetchOk` і читають
тіло як `blob` / `arrayBuffer`.

**Скасування.** Кожен loader приймає `AbortSignal`. На кожну спробу: `AbortSignal.any([signal,
AbortSignal.timeout(ms)])` — тож скасування гравцем (`AbortError`) і таймаут (`TimeoutError`)
розрізняються за `err.name`. Якщо один файл остаточно впав, `loadAll` скасовує решту через
внутрішній `AbortController`, щоб запити не висіли у фоні.

**Повтори (retry).** `withRetry`: до 3 повторів, пауза = `random(0, min(4000, 300 · 2^attempt))`
мс (exponential backoff з *full jitter* — клієнти не б'ють у сервер синхронно). Пауза
переривається `abort`, а не дочікується до кінця.

| Помилка | Ретраїмо? | Чому |
|---|---|---|
| мережа (`TypeError`), `TimeoutError`, HTTP 5xx | так | може минути сама |
| HTTP 4xx (404, 403, …) | **ні** | запит неправильний — повтор дасть те саме |
| `SyntaxError` (битий JSON) | ні | файл не «виправиться» від повтору |
| `AbortError` | ні | це рішення гравця |

**Прогрес.** `onProgress({ key, loaded, total, fraction })` викликається при завершенні **кожного**
файлу; `fraction` зважений за `bytes` з маніфесту, тож бар відображає частку реально
завантажених даних (не таймер). Файли завершуються в довільному порядку — це видно на
скріншоті: ✔ `atlas`, `ships`, `fire`, `hit` вже є, а `bullets` ще ні.

![loading](docs/01-loading-progress.png)

### Sequential `await` проти concurrent `Promise.all`

`scripts/bench.mjs` вантажить той самий маніфест (7 файлів) двома способами: `for … await` та
`Promise.all`. Кожному файлу мок-сервер додає затримку (`?delay=`), що імітує мережу; медіана
з 5 прогонів. Вимірюється мережевий шар (`fetch` + читання тіла), без декодування.

| Затримка на файл | Sequential (`await` у циклі) | Concurrent (`Promise.all`) | Прискорення |
|---|---|---|---|
| 0 мс (localhost) | 15 мс | 9 мс | ×1.7 |
| 100 мс | 720 мс | 106 мс | ×6.8 |
| 200 мс | 1417 мс | 207 мс | ×6.8 |

Sequential ≈ **сума** затримок (7 × 200 мс ≈ 1400 мс), concurrent ≈ **найповільніший** файл
(≈ 200 мс). На localhost затримка майже нульова, тому виграш невеликий; на реальній мережі
різниця — у рази.

## Спрайти

Кораблі, кулі й астероїди малюються з трьох спрайтшитів (`ships.png` 3×2: без тяги / два кадри
полум'я × нормальний і пошкоджений корпус при `hp ≤ 1`; `bullets.png` — 2 кадри пульсації;
`asteroids.png` — 3 варіанти). `atlas.json` описує кадри, `SpriteSheet.draw(ctx, frame, x, y,
{ width, angle })` малює кадр із центром і поворотом. Спрайти згенеровані скриптом
`tools/generate_assets.py`. Картинки декодуються як `ImageBitmap` (`createImageBitmap`) — поза
головним потоком.

![game](docs/03-game.png)

## Звук (Web Audio)

* Буфери **декодуються на завантаженні** (`loadAudio` → `decodeAudioData`). Для цього не
  потрібен живий `AudioContext`, тому декодування йде через `OfflineAudioContext`, а готовий
  `AudioBuffer` можна відтворювати в будь-якому контексті.
* `AudioContext` створюється в `audio.start()`, який викликається з обробника кліку `Join`
  — тобто **після жесту гравця** (autoplay policy). Якщо створити контекст раніше, він був би
  `suspended`.
* Кожен постріл — окремий `AudioBufferSourceNode` з невеликим випадковим `playbackRate`.

## Шина подій

`createBus()` — це `EventTarget`; `emit(type, detail)` диспатчить `CustomEvent`, `on(type, fn,
{ signal })` підписується. `game.js` лише **публікує** `fired` (постріл), `hit` (влучання) і
`exploded` (знищення астероїда / корабля); `audio.js` і `hud.js` — підписуються. **Симуляція не
імпортує `audio.js` і HUD**, а ті не імпортують одне одного: звук чи лічильники можна додати або
прибрати, не чіпаючи правил гри. Шина передається в `createGame(arena, { bus })`; без шини
`emit` — порожня функція.

## Лобі

`GET /api/rooms` віддає `server/mock-api.js` (поки що статичний `rooms.json` з трохи «живими»
`players`). `class Lobby extends EventTarget` — лише логіка, події: `rooms`, `error`, `status`,
`select`, `join`. DOM — `lobby/lobbyView.js`, який підписаний на події й нічого не знає про fetch.

* **Оновлення по інтервалу, поки лобі видиме:** ланцюжок `setTimeout` (не `setInterval`, щоб
  запити не накладались), 3 с. Коли вкладка прихована (`visibilitychange`) — опитування
  зупиняється й оживає знову при поверненні.
* **`AbortSignal.timeout` на кожен запит** (2.5 с) разом з керованим `AbortController`.
* **Abort, щойно гравець пішов:** `join()` і `stop()` скасовують запит у польоті. `AbortError`
  не показується гравцеві як помилка.
* Вибір кімнати → `Join` стартує локальну гру з конфігом арени кімнати (`arena`, `asteroids`);
  канвас підлаштовується під розмір арени.

![lobby](docs/02-lobby.png)

## Головоломки: порядок мікрозадач і задач

Кожна запускається в браузері (`/puzzles/`); виводи нижче — **фактичні**, зняті в Chromium
(3 прогони, однаково). Правило: після кожної задачі (і після кожного callback'а) черга
мікрозадач (`.then`, `await`) спорожнюється **повністю**, і лише потім — наступна задача
(`setTimeout`) чи кадр (`requestAnimationFrame`).

**1. `await null` проти `.then`**

```js
console.log('A');
async function f() { console.log('B'); await null; console.log('C'); }
f();
Promise.resolve().then(() => console.log('D'));
console.log('E');
```

Вивід: `A B E C D`. Тіло `f` виконується синхронно до першого `await` (тому `B` до `E`), а
продовження `C` ставиться в мікрозадачі раніше, ніж `D`.

**2. `setTimeout` усередині `.then`**

```js
setTimeout(() => console.log('timeout 1'), 0);
Promise.resolve()
  .then(() => { console.log('then 1'); setTimeout(() => console.log('timeout 2'), 0); })
  .then(() => console.log('then 2'));
console.log('sync');
```

Вивід: `sync, then 1, then 2, timeout 1, timeout 2`. Обидва `.then` — мікрозадачі й виконуються до
будь-якого таймера; `timeout 1` у черзі задач раніше за `timeout 2`, бо створений раніше.

**3. `resolve(promise)` коштує зайві тіки**

```js
new Promise((resolve) => resolve(Promise.resolve())).then(() => console.log('resolved-with-promise'));
Promise.resolve()
  .then(() => console.log('1')).then(() => console.log('2'))
  .then(() => console.log('3')).then(() => console.log('4'));
```

Вивід: `1, 2, resolved-with-promise, 3, 4`. Виконати проміс *іншим промісом* — це додаткова
мікрозадача на підписку + ще одна на розв'язання, тож його `.then` спрацьовує лише на 3-му
тіку (а не на 1-му, як здавалось би).

**4. `requestAnimationFrame` і мікрозадачі**

```js
requestAnimationFrame(() => { console.log('raf 1'); Promise.resolve().then(() => console.log('micro in raf 1')); });
requestAnimationFrame(() => console.log('raf 2'));
Promise.resolve().then(() => console.log('micro'));
console.log('sync');
```

Вивід: `sync, micro, raf 1, micro in raf 1, raf 2`. rAF-колбеки чекають кадру, тож `micro` йде
першим; а мікрозадача, поставлена *всередині* `raf 1`, виконується одразу після того callback'а
— ще до `raf 2`.

**5. `catch` → `finally` → `then` серед сусідніх `.then`**

```js
Promise.reject(new Error('x'))
  .catch(() => { console.log('catch'); return 'ok'; })
  .finally(() => console.log('finally'))
  .then((v) => console.log(`then ${v}`));
Promise.resolve().then(() => console.log('other 1')).then(() => console.log('other 2'))
  .then(() => console.log('other 3')).then(() => console.log('other 4'));
```

Вивід: `catch, other 1, finally, other 2, other 3, other 4, then ok`. Помилка «поглинається» на
`catch`, а ланцюжки йдуть тік-у-тік поруч; `finally` під капотом повертає проміс (щоб передати
значення далі), тому наступний `.then` відстає на кілька тіків — `then ok` після `other 4`.

## Галерея збоїв

Гра не падає: завантаження закінчується або стартом, або повідомленням на канвасі з кнопкою
**Retry**; збій лобі показується текстом, а опитування триває. Відтворення — параметром
`?fail=…` (`src/faults.js`); демонстраційний збій діє до першого **Retry** (лобі — на перші 2
запити), далі все працює, щоб показати відновлення.

| Збій | Як відтворити | Що відбувається |
|---|---|---|
| **404 спрайта** | `/?fail=sprite404` | `ships.png` → 404 → `HttpError(404)`, **без ретраю** (4xx); решту запитів скасовано; за ~0.3 с — «Файл недоступний: HTTP 404» + Retry. |
| **Таймаут мережі** | `/?fail=timeout` | Сервер відповідає через 15 с, таймаут спроби 1.5 с → 3 повтори з backoff + jitter (на екрані `↻ … (повтор 3)`) → за ~7 с «Мережа не відповіла вчасно» + Retry. |
| **Abort посеред завантаження** | `/?fail=abort` (або `Esc` вручну) | Через 400 мс `controller.abort()` → `AbortError`, **без ретраю**, сусідні запити скасовано → «Завантаження скасовано» + Retry. |
| **Битий JSON** | `/?fail=badjson` | `atlas.json` обірваний → `SyntaxError` від `res.json()`, без ретраю → «Файл пошкоджений (невалідний JSON)» + Retry. |
| **Таймаут лобі** | `/?fail=lobby-timeout` | Перші 2 запити `/api/rooms` висять 10 с → `AbortSignal.timeout(2500)` → «Сервер не відповів вчасно — пробуємо ще…»; далі лобі саме оживає. |
| **HTTP 500 у лобі** | `/?fail=lobby-500` | Текст помилки у лобі, опитування триває, на 3-му запиті список з'являється. |

| 404 спрайта | Таймаут мережі |
|---|---|
| ![404](docs/failure-1-sprite-404.png) | ![timeout](docs/failure-2-network-timeout.png) |

| Abort посеред завантаження | Битий JSON |
|---|---|
| ![abort](docs/failure-3-abort-mid-load.png) | ![json](docs/failure-4-broken-json.png) |

![lobby timeout](docs/failure-5-lobby-timeout.png)

## Reflection (для захисту)

- `fetch` повертає проміс — коли він `rejected`, а коли `fulfilled`? Чому 404 потрапляє у
  `fulfilled` і що ми зробили в `fetchOk`?
- Чому `Promise.all` швидший за `await` у циклі для 7 файлів? Що станеться з рештою запитів, якщо
  один впаде, і як ми це контролюємо?
- Чому не ретраїмо 4xx і битий JSON, а 5xx та таймаут — ретраїмо? Навіщо jitter у backoff?
- Чому `AudioContext` створюється в обробнику `Join`, а буфери декодуються раніше? Як це
  можливо без живого контексту?
- Чому симуляція публікує події в шину, а не викликає `audio.play()` напряму? Що виграємо?
- Чому в лобі `setTimeout`-ланцюжок, а не `setInterval`, і навіщо `abort` при виході гравця?

## Здача

```bash
git add .
git commit -m "lab-03: async asset pipeline, sprites, Web Audio, event bus, lobby"
git push
git tag lab-03
git push origin lab-03
```

Захист — 5 хв: loading (прогрес-бар) → лобі (вибір кімнати) → постріл зі звуком + 2–3 питання з
розділу **Reflection**.

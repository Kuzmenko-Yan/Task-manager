# 📋 Канбан — таск-менеджер для Telegram Mini App

PWA-приложение для управления задачами в стиле Kanban. Работает как
**Telegram Mini App** (автовход через Telegram) и как обычное веб-приложение
(вход по email + пароль). Данные хранятся в **Supabase** (Postgres).

## Возможности

- 🗂️ Канбан-доска: Бэклог → To Do → В процессе → Готово
- 🎯 Drag & Drop — перетаскивание задач между колонками
- ✈️ Вход через Telegram Mini App (проверка подписи initData)
- 🔑 Фолбэк: регистрация по email + пароль
- 👥 Многопользовательский режим — у каждого своя доска
- 🌙 Автоматическая тёмная тема в Telegram
- 📱 PWA — установка на домашний экран iOS/macOS
- 🎤 Голосовой ввод (Web Speech API — Этап 2, вне Telegram WebView)

## Стек

- **Бэкенд:** Node.js + Express
- **БД:** Supabase (Postgres) через `@supabase/supabase-js`
- **Фронтенд:** HTML/CSS + Vanilla JS + SortableJS + Telegram Web App SDK
- **Авторизация:** JWT (access + refresh) + bcryptjs, HMAC-проверка Telegram initData

## Настройка (один раз)

### 1. Supabase

1. Создайте проект на [supabase.com](https://supabase.com).
2. Откройте **SQL Editor** и выполните скрипт [`supabase/schema.sql`](supabase/schema.sql) —
   он создаст таблицы `users` и `tasks`, индексы и включит RLS.
3. В **Project Settings → Data API** возьмите:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` ключ → `SUPABASE_SERVICE_ROLE_KEY` (секретный, только сервер!)

### 2. Бот в Telegram (@BotFather)

1. `/newbot` — создайте бота, получите токен → `BOT_TOKEN`.
2. `/newapp` — привяжите Mini App к боту: укажите название, описание,
   фото и **HTTPS-URL** задеплоенного приложения (см. деплой ниже).
3. `/setmenubutton` (или кнопка в чате бота) — чтобы открывать Mini App
   одним нажатием.

### 3. Переменные окружения

Скопируйте `.env.example` в `.env` и заполните (значения ни куда не публикуйте):

```bash
cp .env.example .env
```

| Переменная | Где взять |
|---|---|
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SUPABASE_URL` | Supabase → Project Settings → Data API |
| `SUPABASE_SERVICE_ROLE_KEY` | Там же, ключ `service_role` (секретный!) |
| `BOT_TOKEN` | @BotFather |

## Локальный запуск

```bash
npm install
npm run dev
```

Открыть: `http://localhost:3000`

- Если `.env` с реальными ключами Supabase заполнен — работа идёт
  против настоящей базы.
- Если `.env` нет — автоматически поднимается встроенный мок Supabase
  (`dev/mock-supabase.js`), данные живут в памяти до перезапуска.
  Так можно проверить всё приложение без единого секрета.

> Telegram Mini App требует **HTTPS**, поэтому в Telegram
> проверять можно только через туннель (например, `ngrok http 3000`)
> или после деплоя.

## Деплой (Render / Railway)

1. Запушьте репозиторий на GitHub.
2. Создайте Web Service из репозитория:
   - Build Command: `npm install`
   - Start Command: `npm start`
3. В панели хостинга задайте переменные окружения (`JWT_SECRET`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BOT_TOKEN`) —
   **в панели, не в коде и не в чате**.
4. Полученный HTTPS-URL пропишите в @BotFather (`/newapp` → URL,
   или `/myapps` → Edit для существующего).

## API

| Метод | Путь | Описание |
|--------|------|----------|
| POST | `/api/auth/telegram` | Вход из Mini App `{initData}` |
| POST | `/api/auth/register` | Регистрация `{email, password}` |
| POST | `/api/auth/login` | Вход `{email, password}` |
| POST | `/api/auth/refresh` | Обновление пары токенов |
| POST | `/api/auth/logout` | Отзыв refresh-токенов |
| GET | `/api/me` | Информация о пользователе |
| GET | `/api/tasks` | Список задач (JWT) |
| POST | `/api/tasks` | Создать задачу |
| PUT | `/api/tasks/:id` | Обновить задачу |
| DELETE | `/api/tasks/:id` | Удалить задачу |
| POST | `/api/tasks/reorder` | Перемещение задач (drag & drop) |

## Структура проекта

| Файл | Описание |
|------|----------|
| `server.js` | Express-сервер: JWT-аутентификация, проверка Telegram initData (HMAC-SHA256), REST API задач на Supabase |
| `supabase/schema.sql` | Схема БД: таблицы users/tasks, индексы, RLS |
| `public/app.js` | Логин (Telegram + email), CRUD задач, Drag & Drop, темы |
| `public/sw.js` | Service Worker (cache-first с обновлением) |
| `public/index.html` | DOM: экран авторизации, доска, модалка, PWA + Telegram SDK |
| `public/style.css` | CSS-переменные, светлая/тёмная темы, адаптивность |

## Безопасность

- Все секреты — только в переменных окружения (`.env` локально,
  панель хостинга в проде). `.env` в `.gitignore`.
- `SUPABASE_SERVICE_ROLE_KEY` и `BOT_TOKEN` никогда не попадают
  во фронтенд и в репозиторий.
- Подпись Telegram initData проверяется на сервере (HMAC-SHA256,
  timing-safe сравнение, свежесть `auth_date` ≤ 24 ч).
- RLS в Supabase включён; сервер фильтрует данные по `user_id`.

## Лицензия

MIT

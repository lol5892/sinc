# sinc

**Telegram Mini App** — совместное планирование недели (слева шкала 0–24, сверху дни; блоки дел перетаскиваются и тянутся по высоте) + бот с напоминаниями в чат. Стек: Vite + React, Express, данные в файле `data/events.json`, Telegraf.

Для разработки с разных машин удобен ещё **Git** и удалённый репозиторий.

## Telegram: один раз настроить

1. Скопируй `.env.example` в `.env`: `BOT_TOKEN` ([@BotFather](https://t.me/BotFather)), `TELEGRAM_ALLOWED_IDS` (два id через запятую — [@userinfobot](https://t.me/userinfobot)), `WEB_APP_URL` — публичный **https** после деплоя (тот же базовый URL, что у фронта и API).
2. В BotFather задай домен / Menu Button для Mini App на этот же URL.
3. В облаке (Railway, Render, Fly.io и т.д.): старт `npm run start`, переменная `PORT` с платформы. Один процесс отдаёт `dist/` и `/api`.
4. Оба пользователя нажали **Start** у бота — иначе личные напоминания могут не доставиться.

Локально `npm run dev` поднимает Vite (:5173, прокси `/api` → :3001) и сервер. Без Telegram в браузере: в `.env` добавь `VITE_DEV_USER_ID=<твой id>` (этот id должен быть в `TELEGRAM_ALLOWED_IDS`).

## Локальный запуск (после `npm install`)

```bash
npm run dev
```

Открой адрес Vite в браузере; с телефона в той же Wi‑Fi — `http://IP_ПК:5173` (IP — `ipconfig`).

## Уходишь с ПК — чтобы на телефоне в Cursor был этот проект

Без **одного** `push` на GitHub телефон не увидит историю Git так же, как ПК.

1. На телефоне в браузере: [github.com/new](https://github.com/new) — репозиторий **sinc**, **без** README / .gitignore.
2. Скопируй HTTPS-ссылку вида `https://github.com/ЛОГИН/sinc.git`.
3. На ПК в папке проекта в PowerShell:

   ```powershell
   .\push.ps1 "https://github.com/ЛОГИН/sinc.git"
   ```

   Войди в GitHub, если спросит. После успешного `push` код на сервере.

4. В Cursor на телефоне / в вебе: **Clone** этого репозитория, затем в терминале проекта `npm install` и при необходимости `git pull`.

## Синхронизация между устройствами

Git сам по сети не «толкает» файлы. Чтобы на телефоне и в веб-версии Cursor был тот же код:

1. **Создай пустой репозиторий** на GitHub (или другом хостинге), без README, если он уже есть в папке.
2. **На этом ПК** (из папки проекта):

   ```bash
   git remote add origin https://github.com/ТВОЙ_ЛОГИН/sinc.git
   git branch -M main
   git push -u origin main
   ```

3. **Перед работой на другом устройстве** открой тот же проект в Cursor и выполни:

   ```bash
   git pull
   ```

4. **После правок** — сохрани файлы, затем:

   ```bash
   git add -A
   git commit -m "кратко что сделано"
   git push
   ```

Так изменения появятся на другом устройстве сразу после `pull` (и наоборот).

## Если папка на телефоне пустая

Один раз клонируй репозиторий:

```bash
git clone https://github.com/ТВОЙ_ЛОГИН/sinc.git
cd sinc
npm install
```

Дальше только `git pull` / коммиты / `git push`.

## OneDrive

Папка уже в OneDrive — это отдельная синхронизация файлов. Для Cursor на разных машинах надёжнее опираться на **git push/pull**, чтобы не смешивать конфликтующие копии.

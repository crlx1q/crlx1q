# План будущих улучшений CRLX1Q

Этот файл — заметка для следующего ИИ-агента. Сейчас проект откатан к стабильному состоянию с фиксoм курсора. Не реализуй всё сразу: сначала согласуй с владельцем сайта и делай маленькими PR.

## Уже сделано и должно остаться

- При `prefers-reduced-motion: reduce` кастомный курсор отключается, а родной системный курсор возвращается.
- Двойной glitch `CRL.X1Q()` в навбаре — намеренная фишка, не удалять как “дублирование”.

## Идеи для сайта

1. **System-aware mode в DEBUG**
   - Показывать в debug-панели: motion preference, pointer type, DPR, save-data, примерный профиль качества.
   - Это должно выглядеть как часть “CRLX1Q system shell”, а не как обычная таблица настроек.

2. **Авто-качество графики по FPS**
   - В `auto` режиме снижать нагрузку canvas/background при просадке FPS.
   - Возможные параметры: реже обновлять фон, уменьшать радиус подсветки, отключать shimmer.
   - При стабильном FPS возвращать balanced/full режим.

3. **Команды терминала `system` / `profile`**
   - Команда должна выводить detected profile: motion, pointer, canvas, DPR, quality.
   - Вывод держать в стиле Windows/terminal UI сайта.

4. **Ручной переключатель качества в консоли**
   - Команды: `quality`, `quality auto`, `quality full`, `quality eco`.
   - Сохранять выбор в `localStorage`.
   - `auto` должен уважать системные настройки ПК.

5. **Более честный boot screen**
   - Во время загрузки показывать реальные detected-факты: reduced motion, pointer, render profile.
   - Не ломать текущую эстетику boot-анимации.

## Идеи “под капот”

2. **Локальная Tailwind-сборка, но осторожно**
   - Не добавлять обязательные зависимости без lockfile.
   - Для Heroku обязательно проверить build перед PR.
   - Если делать локальную сборку — добавить нормальный `package-lock.json` и убедиться, что хостинг ставит зависимости без ошибок.

3. **Security headers**
   - Добавить аккуратно: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, CSP.
   - CSP проверять в браузере, потому что Tailwind CDN и inline scripts могут требовать исключений.

4. **Cache headers**
   - HTML/API: `no-cache`.
   - Статика (`logo.png`, css/js/assets): long cache, если имена файлов версионируются.

5. **Notes schema: id/date/createdAt**
   - Новым заметкам выдавать стабильный `id` и `createdAt` ISO timestamp.
   - Старые заметки мигрировать аккуратно, без потери текущих записей.
   - Желательно atomic write + backup для `notes.json`.

6. **Rate limit надёжнее**
   - Сейчас можно оставить простой лимит, но потом добавить cleanup Map и поддержку `X-Forwarded-For` за proxy/CDN.
   - Не сломать отправку заметок обычным пользователям.

9. **SEO/social preview**
   - Добавить Open Graph, Twitter card, canonical, preview image.
   - Проверить, как ссылка выглядит в Telegram/Discord.

10. **`/health` endpoint**
   - Простой JSON: `{ ok, version, uptime, timestamp }`.
   - Полезно для Heroku/мониторинга.

## Важное правило

Не делать большой PR на всё сразу. Лучше порядок такой:

1. `/health` + headers.
2. Notes `id/createdAt` + backup.
3. DEBUG system/profile UI.
4. Terminal `system/profile/quality`.
5. Adaptive FPS quality.
6. SEO/manifest.
7. Tailwind build only после проверки Heroku.

## Deploy note

- Для Heroku держать `package-lock.json` в репозитории, даже если зависимостей нет: buildpack по lockfile определяет npm и не падает с `Missing lockfile`.

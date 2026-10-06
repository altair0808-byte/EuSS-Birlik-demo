# Исправление: «На экран Домой» открывает сайт, а не приложение

**Причина.** `manifest.webmanifest` ссылался на `/icons/icon-512.png`, `/icons/maskable-192.png`, `/icons/maskable-512.png`,
а на сервере их не было (в репозитории лежал только `icon-192.png`, и не в `assets/icons/`, а в `assets/fonts/icons/`).
Без иконки 512x512 Chrome не считает сайт устанавливаемым приложением и добавляет обычную закладку.

**Что сделано**
- `assets/icons/`: созданы `icon-192.png`, `icon-512.png`, `maskable-192.png`, `maskable-512.png`; добавлены `apple-touch-icon.png`, `favicon-*`.
- `public/manifest.webmanifest`: иконки приведены в соответствие с файлами.
- `Server.js`: `/icons` отдаётся и из `assets/fonts/icons/` (запасной путь), чтобы ошибка с папкой не повторилась.

**После выкладки на телефоне:** удалить старый ярлык с экрана «Домой», открыть сайт в Chrome (Android) / Safari (iPhone) и добавить заново.

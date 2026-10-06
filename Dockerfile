# Образ для Render (или любого другого Docker-хостинга).
# Нужен именно Docker, а не «нативный» Node-рантайм Render — там нет доступа
# к apt-get/системным пакетам, а LibreOffice — это системный пакет, не npm.

FROM node:20-bookworm-slim

# libreoffice-writer — достаточно (только конвертация .docx -> .pdf, не нужен
# полный офисный пакет с Calc/Impress — это ощутимо экономит время сборки и
# размер образа). unoconv/python3-uno — клиент, который подключается к уже
# ЗАПУЩЕННОМУ LibreOffice (см. start.sh) вместо того, чтобы поднимать его заново
# на каждый запрос (иначе каждое «Скачать PDF» — это заново запустить весь
# LibreOffice, 10-40+ секунд на слабом сервере). Шрифты — чтобы кириллица в PDF
# не превращалась в кракозябры.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      unoconv \
      python3-uno \
      fonts-dejavu \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# npm ci требует package-lock.json (его в проекте нет — используется bun.lock),
# поэтому ставим через обычный npm install.
RUN npm install --omit=dev

COPY . .
RUN chmod +x start.sh

ENV NODE_ENV=production
# Render сам передаёт правильный PORT через переменную окружения — Server.js
# уже её читает (process.env.PORT), ничего дополнительно указывать не нужно.

CMD ["./start.sh"]

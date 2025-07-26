# --- Этап 1: Сборщик (Builder) ---
# Используем образ Node.js для установки зависимостей и сборки TypeScript
FROM node:20-alpine AS builder

# Устанавливаем рабочую директорию
WORKDIR /usr/src/app

# Копируем файлы с зависимостями
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код
COPY . .

# Собираем TypeScript в JavaScript
RUN npm run build

# --- Этап 2: Финальный образ (Production) ---
# Используем тот же легковесный образ Node.js
FROM node:20-alpine

WORKDIR /usr/src/app

# Копируем package.json для установки только production-зависимостей
COPY package*.json ./
RUN npm install --omit=dev

# Копируем собранный код из этапа "builder"
COPY --from=builder /usr/src/app/dist ./dist

# Указываем команду для запуска приложения
CMD ["node", "dist/index.js"]

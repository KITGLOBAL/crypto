# Этап сборки
FROM node:20-slim AS builder

# Устанавливаем только базовые инструменты для сборки нативных модулей (если нужны)
# Графические библиотеки (cairo, pango) удалены, так как карты ликвидности больше нет
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Копируем package.json и lock файлы (если есть)
COPY package*.json ./

# Устанавливаем зависимости (включая devDependencies для сборки TypeScript)
RUN npm install

# Копируем исходный код
COPY . .

# Собираем проект (TypeScript -> JavaScript в папку dist)
RUN npm run build

# Этап продакшн
FROM node:20-slim

# В продакшене нам не нужны даже компиляторы, только Node.js
# Очищаем кэш apt для минимизации размера образа
RUN apt-get update && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

# Устанавливаем только production зависимости
RUN npm install --omit=dev

# Копируем собранный код из этапа builder
COPY --from=builder /usr/src/app/dist ./dist

# Запускаем
CMD ["node", "dist/index.js"]
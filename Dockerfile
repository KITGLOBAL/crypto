# Этап сборки
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

FROM node:20-slim

RUN apt-get update && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /usr/src/app/dist ./dist

# Запускаем
CMD ["node", "dist/index.js"]
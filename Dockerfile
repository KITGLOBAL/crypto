# Этап сборки
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
    pkg-config \
    libpixman-1-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    libpng-dev

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Этап продакшн
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    libpixman-1-0 \
    libcairo2 \
    libpango1.0-0 \
    libjpeg-dev \
    libgif-dev \
    libpng-dev

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /usr/src/app/dist ./dist

CMD ["node", "dist/index.js"]
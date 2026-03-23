FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libopenslide0 \
    libopenslide-dev \
    libvips-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY app.js ./

RUN mkdir -p annotations patches static/thumbnails

EXPOSE 7860

ENV PORT=7860 \
    HOST=0.0.0.0 \
    NODE_ENV=production

CMD ["node", "app.js", "--no-browser"]

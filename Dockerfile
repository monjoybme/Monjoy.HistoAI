FROM node:20-slim

# Install OpenSlide C library (required for local WSI files)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopenslide0 \
    libopenslide-dev \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy app source
COPY app.js ./

# Create persistent directories (bind-mounted in production)
RUN mkdir -p annotations patches static/thumbnails

# Expose port
EXPOSE 5000

# Environment defaults (override at runtime)
ENV PORT=5000 \
    HOST=0.0.0.0 \
    NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT}/api/stats || exit 1

CMD ["node", "app.js", "--no-browser"]

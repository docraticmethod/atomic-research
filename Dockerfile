FROM node:24-slim

WORKDIR /app

# Install dependencies first for layer caching.
# All deps (including tsx/typescript) are needed at runtime — no separate build step.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source. data/ and public/ are bind-mounted at runtime; .env is never baked in.
COPY tsconfig.json ./
COPY src/ ./src/

# pipeline writes to /app/public; dashboard reads from it.
# Both directories are mounted from the host, so data persists outside the container.
RUN mkdir -p /app/public /app/data

EXPOSE 4000

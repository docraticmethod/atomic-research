FROM node:24-slim

WORKDIR /app

# Install dependencies first for layer caching.
# All deps (including tsx/typescript) are needed at runtime — no separate build step.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source. public/ is bind-mounted at runtime; .env is never baked in.
# v3.2: there is NO data/ fixtures dir — INPUT is the live OpenAlex client
# (outbound egress to api.openalex.org). public/ is the OUTPUT surface.
COPY tsconfig.json ./
COPY src/ ./src/

# pipeline writes to /app/public; dashboard reads from it (mounted from host).
RUN mkdir -p /app/public

EXPOSE 4000

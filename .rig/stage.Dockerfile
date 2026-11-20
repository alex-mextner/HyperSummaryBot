# Stage image uses an empty ephemeral database, migrated before starting the bot.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
ENV HOME=/tmp BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/bun-cache
USER 65532:65532
CMD ["sh", "-c", "bun --no-env-file scripts/migrate-db.ts && exec bun --no-env-file src/index.ts"]

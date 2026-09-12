FROM oven/bun:1.3.13
COPY --from=ghcr.io/astral-sh/uv:0.11.15 /uv /bin/uv
RUN uv python install 3.12
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY harbor/runner ./harbor/runner
COPY configs ./configs

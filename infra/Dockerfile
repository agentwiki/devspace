# Shared image for all four services. Each compose service overrides `command`
# (which app's dist/main.js to run) and `PORT`.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# --- deps + build ---
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm -r build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
# Default command is overridden per service in compose.
CMD ["node", "apps/orchestrator-svc/dist/main.js"]

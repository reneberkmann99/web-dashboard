# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client (use local binary, not npx which may fetch latest)
RUN ./node_modules/.bin/prisma generate

# Build Next.js (standalone output)
RUN npm run build

# ---------- prisma-cli ----------
# Install prisma CLI with ALL transitive deps (keep version in sync with package.json)
FROM node:20-alpine AS prisma-cli
WORKDIR /tmp/prisma
RUN npm init -y && npm install --save-exact prisma@6.19.2

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Next.js standalone output (includes its own minimal node_modules)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

# Prisma CLI + all transitive deps (merged into standalone node_modules)
COPY --from=prisma-cli /tmp/prisma/node_modules ./node_modules

# Generated Prisma client + schema (needed for migrations)
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
CMD ["./docker-entrypoint.sh"]

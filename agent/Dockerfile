FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN apk add --no-cache docker-cli docker-cli-compose && npm ci --omit=dev

COPY agent/ ./agent/
COPY tsconfig.json ./

EXPOSE 8081
CMD ["npx", "tsx", "agent/src/index.ts"]

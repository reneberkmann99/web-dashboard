FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY agent/ ./agent/
COPY tsconfig.json ./

EXPOSE 8081
CMD ["npx", "tsx", "agent/src/index.ts"]

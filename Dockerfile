FROM node:20-alpine AS base

RUN apk add --no-cache openssl

WORKDIR /app

FROM base AS build

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm exec prisma generate
RUN npm run build

FROM base AS production

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY prisma ./prisma
RUN npm exec prisma generate --schema prisma/postgres/schema.prisma

COPY --from=build /app/build ./build

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "npm exec prisma migrate deploy --schema prisma/postgres/schema.prisma && npm run start"]

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci --omit=dev
# Schema + migrations for `migrate deploy` at boot
COPY prisma ./prisma
COPY --from=build /app/dist ./dist
# Generated Prisma client is plain JS; dist imports resolve it at ./dist/generated
COPY --from=build /app/src/generated ./dist/generated
# Coolify passes the deployed commit as SOURCE_COMMIT; surfaced via /health
ARG SOURCE_COMMIT
ENV GIT_SHA=$SOURCE_COMMIT
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]

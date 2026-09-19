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
# The generated Prisma client is plain JS, so `tsc` emits nothing for it; `npm run
# build` mirrors it into dist/generated, and it travels inside this one copy.
# A second COPY of src/generated would write the same ~40 MB into a second layer.
COPY --from=build /app/dist ./dist
# Coolify passes the deployed commit as SOURCE_COMMIT; surfaced via /health
ARG SOURCE_COMMIT
ENV GIT_SHA=$SOURCE_COMMIT
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]

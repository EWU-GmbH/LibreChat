FROM node:24.16.0-bookworm-slim

WORKDIR /app

COPY packages/api/documents/package.json packages/api/documents/package-lock.json ./

RUN npm ci --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
ENV DOCUMENT_STORAGE_PATH=/data

COPY packages/api/src/documents ./src

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

CMD ["node_modules/.bin/tsx", "src/server.ts"]

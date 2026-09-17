FROM node:24.16.0-bookworm-slim

WORKDIR /app

COPY . .

RUN npm ci --omit=dev --workspace @librechat/api --include-workspace-root=false

ENV NODE_ENV=production
ENV PORT=3000
ENV DOCUMENT_STORAGE_PATH=/data

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

CMD ["node_modules/.bin/tsx", "packages/api/src/documents/server.ts"]

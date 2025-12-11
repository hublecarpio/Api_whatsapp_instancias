FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build && mkdir -p /app/src/storage/sessions

FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/storage ./src/storage

RUN chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=4080

USER node

EXPOSE 4080 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD node -e "const port = process.env.PORT || 4080; require('http').get('http://localhost:' + port + '/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]

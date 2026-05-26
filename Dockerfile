FROM oven/bun:1.3-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/shop.db

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]

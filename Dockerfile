FROM oven/bun:1.3-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/shop.db

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]

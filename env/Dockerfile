FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_FILE=/data/review.json

VOLUME ["/data"]
EXPOSE 8080

RUN mkdir -p /data && chown node:node /data
USER node

CMD ["node", "src/server.js"]

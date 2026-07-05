FROM node:24-alpine

# su-exec lets the entrypoint chown the SQLite volume as root, then drop to the
# unprivileged `node` user for the app itself (issue #38).
RUN apk add --no-cache su-exec

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8484
# Start as root so the entrypoint can chown a fresh /data volume; it then
# su-execs to `node`. No `USER node` here — the entrypoint owns the step-down.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--experimental-strip-types", "src/gateway/index.ts"]

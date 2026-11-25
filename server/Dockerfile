FROM node:20-alpine

ENV NODE_ENV=production
# versión y commit para /healthz (CI los pasa; Coolify pasa SOURCE_COMMIT si está activado)
ARG APP_VERSION=""
ARG GIT_SHA=""
ARG SOURCE_COMMIT=""
ENV APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA SOURCE_COMMIT=$SOURCE_COMMIT
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

# datos persistentes (conexión con Meta cifrada); montar un volumen aquí
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

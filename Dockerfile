FROM node:22.18-bookworm-slim AS build
WORKDIR /app
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_DATA_SOURCE=api NEXT_PUBLIC_APP_NAME=БизнеСоты
ENV APP_BUILD_SHA=$BUILD_SHA APP_BUILD_TIME=$BUILD_TIME
# The webpack/next build cache is build-time only, but `COPY --from=build`
# carries it into the release image. On a 20 GB host that cache is what
# filled the disk during `docker load`. Keep an empty dir so the runtime
# can repopulate it.
RUN npm run build && rm -rf .next/cache && mkdir -p .next/cache

FROM node:22.18-bookworm-slim
WORKDIR /app
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_DATA_SOURCE=api NEXT_PUBLIC_APP_NAME=БизнеСоты
ENV APP_BUILD_SHA=$BUILD_SHA APP_BUILD_TIME=$BUILD_TIME
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["npm","run","start","--","--hostname","0.0.0.0"]

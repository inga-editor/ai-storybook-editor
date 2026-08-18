FROM node:22-bookworm-slim

# ffmpeg (transcode/concat) + Chrome headless shell shared libs.
# Deps list VERIFIED 260818 from remotion.dev/docs/docker (official Dockerfile,
# same base node:22-bookworm-slim).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
    libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 \
    libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -u 999 -m app
WORKDIR /app
RUN chown app: /app
USER app

# deps layer — cached by package-lock.json
COPY --chown=app:app package.json package-lock.json ./
RUN npm ci

# Chrome headless shell baked via @remotion/renderer's ensureBrowser() — the exact
# call the worker uses at render time (src/render.ts). NOT `npx remotion`: this
# project depends on @remotion/renderer as a library, not @remotion/cli, so no
# `remotion` bin exists. Remotion anchors its browser cache (.remotion) at the nearest
# package.json to the caller — the runtime server lives in /app/video-worker, so it
# resolves /app/video-worker/node_modules/.remotion. We therefore stage the
# video-worker manifest FIRST and bake from /app/video-worker so the build lands the
# browser in that exact dir (otherwise the server re-downloads 88MB at every boot).
# Copying only this zero-dep manifest keeps the browser layer cache-stable across FE
# source changes; .dockerignore excludes video-worker/node_modules so the later COPY
# can't clobber the baked browser. Runs as user app, matching the runtime CMD.
COPY --chown=app:app video-worker/package.json video-worker/
WORKDIR /app/video-worker
RUN node --input-type=module -e "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser();"

# source — video-worker + FE src (the composition is a build input of the worker)
WORKDIR /app
COPY --chown=app:app . .

# preflight gate: surface webpack resolve errors (Vite ?url, alias @/) at BUILD
# time, not on the first render on prod (lesson: RENDER_CRASH 260817).
WORKDIR /app/video-worker
RUN npm run preflight

EXPOSE 4000
# env comes from compose env_file (not --env-file like local npm start).
# server.ts binds 127.0.0.1 — loopback boundary unchanged.
CMD ["node", "--import", "tsx", "src/server.ts"]

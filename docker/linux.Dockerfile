FROM node:22-bookworm AS linux-package

ENV DEBIAN_FRONTEND=noninteractive
ENV ELECTRON_CACHE=/root/.cache/electron
ENV npm_config_update_notifier=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dpkg \
    dpkg-dev \
    fakeroot \
    file \
    g++ \
    git \
    libsecret-1-dev \
    make \
    pkg-config \
    python3 \
    rpm \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

ARG APPIMAGETOOL_URL=https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
RUN curl -fsSL "$APPIMAGETOOL_URL" -o /usr/local/bin/appimagetool \
  && chmod +x /usr/local/bin/appimagetool

WORKDIR /workspace

# Keep dependency install cacheable when source files change.
COPY my-app/package.json my-app/yarn.lock ./my-app/
COPY my-app/scripts/chmod-node-pty-helpers.mjs ./my-app/scripts/
WORKDIR /workspace/my-app
RUN sed -i 's#git+ssh://git@github.com/#git+https://github.com/#g; s#ssh://git@github.com/#https://github.com/#g' yarn.lock package.json
RUN yarn install --frozen-lockfile

WORKDIR /workspace
COPY . .

WORKDIR /workspace/my-app
RUN yarn run make -- --platform=linux --arch=x64
RUN node ../scripts/build-linux-appimage.mjs \
    --package-dir "/workspace/my-app/out/Browser Use-linux-x64" \
    --output-dir /workspace/my-app/out/make/appimage/x64 \
  && node scripts/generate-linux-update-feed.mjs \
    --version "$(node -p 'require("./package.json").version')" \
    --release-date "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    --output /workspace/my-app/out/make/latest-linux.yml \
    /workspace/my-app/out/make/appimage/x64/*.AppImage
RUN node ../scripts/verify-linux-artifacts.mjs

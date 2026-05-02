FROM --platform=$TARGETPLATFORM node:22-bookworm AS linux-package

ENV DEBIAN_FRONTEND=noninteractive
ENV ELECTRON_CACHE=/root/.cache/electron
ENV npm_config_update_notifier=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
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

WORKDIR /workspace

# Keep dependency install cacheable when source files change.
COPY my-app/package.json my-app/yarn.lock ./my-app/
WORKDIR /workspace/my-app
RUN yarn install --frozen-lockfile

WORKDIR /workspace
COPY . .

WORKDIR /workspace/my-app
RUN yarn run make -- --platform=linux --arch=x64
RUN node ../scripts/verify-linux-artifacts.mjs

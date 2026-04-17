FROM node:22-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production

COPY dist/ ./dist/

ENV NODE_NO_WARNINGS=1
ENV PYTHONUNBUFFERED=1

CMD ["node", "dist/agent-bundle.js"]

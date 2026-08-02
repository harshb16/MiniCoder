FROM oven/bun:1.3.11
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep coreutils ca-certificates python3 nodejs npm build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/minicoder
COPY package.json bun.lock ./
COPY node_modules ./node_modules
COPY src ./src
RUN chmod -R a-w /opt/minicoder && mkdir -p /workspace /control && chown 1000:1000 /workspace
ENV HOME=/tmp/home GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT []
CMD ["bun", "/opt/minicoder/src/tools/worker.ts"]

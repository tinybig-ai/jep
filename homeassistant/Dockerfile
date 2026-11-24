# jep as a Home Assistant app. The fork publishes per-arch images to GHCR and
# config.json points at them (`image`); CI — .github/workflows/ha-app.yml —
# builds them. With the `image` key removed instead, the same Dockerfile is
# built on the device by the Supervisor.
#
# The jep source itself is cloned at build time rather than vendored into the
# app folder: one source of truth, and the fork stays active by rebuilding.
# Bump `version` in config.json to make CI rebuild, or set
# JEP_REPO / JEP_REF to build from your own fork and branch.
FROM node:26-alpine

ARG BUILD_VERSION="dev"
ARG BUILD_ARCH
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}"

# bash: the opencode installer is a bash script. tmux: the gateway's terminal
# feature. git: agents live in repositories. ffmpeg + python3: voice-note
# transcription (whisper itself stays opt-in — see DOCS.md).
RUN apk add --no-cache \
    bash curl git github-cli tar tmux ffmpeg py3-pip tzdata ca-certificates

# opencode CLI, official installer (picks the right per-arch/musl binary;
# on this Alpine base that is the -musl build). Installer v1 keeps GitHub's
# "latest" release wars out of the image by tracking the newest OpenCode 1
# version; see DOCS.md before switching to the v2 line.
RUN curl -fsSL https://opencode.ai/install | bash \
 && mv /root/.opencode/bin/opencode /usr/local/bin/opencode

# jep runs native TypeScript straight from the source tree (no build step).
# The package's prepare script runs tsc (for npm publishing); the daemon needs
# none of it, and --omit=dev wouldn't have tsc anyway — so skip lifecycle
# scripts entirely.
ARG JEP_REPO="https://github.com/tinybig-ai/jep"
ARG JEP_REF="main"
# CI passes the commit it is building. The clone below is otherwise a cached
# layer: same repo URL, same branch name, yesterday's source.
ARG JEP_SHA=""
# $JEP_SHA is read here on purpose: Docker only drops the cached clone when
# an ARG value changes and that ARG is used by this RUN.
RUN git init /app/jep \
 && git -C /app/jep remote add origin "$JEP_REPO" \
 && git -C /app/jep fetch --depth 1 origin "${JEP_SHA:-$JEP_REF}" \
 && git -C /app/jep checkout --detach FETCH_HEAD \
 && cd /app/jep \
 && npm ci --omit=dev --ignore-scripts \
 && for command in /app/jep/bin/jep*.mjs; do \
      ln -s "$command" "/usr/local/bin/$(basename "$command" .mjs)"; \
    done

COPY run.sh /run.sh
RUN chmod 755 /run.sh

WORKDIR /data/jep
ENTRYPOINT ["/run.sh"]

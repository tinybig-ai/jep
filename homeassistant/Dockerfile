# jep as a Home Assistant app. Built on-device by the Supervisor (this folder
# has no `image` key) or by CI — see .github/workflows/ha-app.yml.
#
# The jep source itself is cloned at build time rather than vendored into the
# app folder: one source of truth, and the fork stays active by rebuilding.
# Bump `version` in config.json to make the Supervisor rebuild, or set
# JEP_REPO / JEP_REF to build from your own fork and branch.
FROM node:26-alpine

# bash: the opencode installer is a bash script. tmux: the gateway's terminal
# feature. git: agents live in repositories. ffmpeg + python3: voice-note
# transcription (whisper itself stays opt-in — see DOCS.md).
RUN apk add --no-cache \
    bash curl git tar tmux ffmpeg py3-pip tzdata ca-certificates

# opencode CLI, official installer (picks the right per-arch/musl binary;
# on this Alpine base that is the -musl build). Installer v1 keeps GitHub's
# "latest" release wars out of the image by tracking the newest OpenCode 1
# version; see DOCS.md before switching to the v2 line.
RUN curl -fsSL https://opencode.ai/install | bash \
 && mv /root/.opencode/bin/opencode /usr/local/bin/opencode

# jep runs native TypeScript straight from the source tree (no build step).
ARG JEP_REPO="https://github.com/tinybig-ai/jep"
ARG JEP_REF="main"
RUN git clone --depth 1 --branch "$JEP_REF" "$JEP_REPO" /app/jep \
 && cd /app/jep \
 && npm ci --omit=dev

COPY run.sh /run.sh
RUN chmod 755 /run.sh

WORKDIR /data/jep
ENTRYPOINT ["/run.sh"]

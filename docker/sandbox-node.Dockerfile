# Sandbox image for the two roles that write and run code.
#
# The base image carries no Node, so the test executor cannot run anything: no tsc,
# no test runner, nothing. It fails at `node: command not found`, which surfaces as an
# opaque `structured_output was not called` throw rather than a useful error.
#
# OpenClaw's own "common" image solves this, but it also installs Go, Rust, Bun and
# Homebrew. This adds Node and nothing else.
#
# Build:
#   docker build -t remi-sandbox-node:bookworm-slim -f docker/sandbox-node.Dockerfile .
#
# Requires openclaw-sandbox:bookworm-slim to exist first (see docs/SETUP.md step 3).
#
# Note on why the test runner is Node's built-in: sandboxed roles run with
# network: "none", so `npm install` cannot work inside a turn. Any test framework would
# have to be baked into this image or vendored into the repository. `node --test` needs
# neither.

ARG BASE_IMAGE=openclaw-sandbox:bookworm-slim
FROM ${BASE_IMAGE}

USER root
ENV DEBIAN_FRONTEND=noninteractive

ARG NODE_MAJOR=24

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL --connect-timeout 10 --max-time 120 \
       -o /tmp/nodesource.sh "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" \
  && bash /tmp/nodesource.sh \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -f /tmp/nodesource.sh \
  && rm -rf /var/lib/apt/lists/*

# Fail the build rather than the pipeline if Node did not land.
RUN node --version && npm --version

USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]

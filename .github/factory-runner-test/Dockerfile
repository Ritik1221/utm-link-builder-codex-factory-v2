# Linux UID integration image for the isolated Codex runner.
#
# Mirrors the production runner image (accounts, home modes, root-owned app and
# launcher, mode-0600 configuration, sudoers rule, 0700 jobs and ledger
# directories) but omits the Actions runner and replaces the Codex CLI with a
# local probe. No model, network service or credential is involved.
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends sudo tar \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 factory-runner \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash factory-runner \
    && groupadd --gid 10002 factory-codex \
    && useradd --uid 10002 --gid 10002 --create-home --shell /usr/sbin/nologin factory-codex \
    && mkdir -p /home/factory-codex/.codex \
    && chown -R factory-codex:factory-codex /home/factory-codex \
    && chmod 0700 /home/factory-runner /home/factory-codex \
    && install -d -o factory-runner -g factory-runner /home/factory-runner/actions-runner/_work/_temp

COPY factory /usr/local/libexec/factory-codex/app
RUN cp /usr/local/libexec/factory-codex/app/runner/execute-launcher.sh /usr/local/libexec/factory-codex/execute \
    && chown -R root:root /usr/local/libexec/factory-codex \
    && find /usr/local/libexec/factory-codex -type d -exec chmod 0755 {} + \
    && find /usr/local/libexec/factory-codex/app -type f -exec chmod 0644 {} + \
    && chmod 0755 /usr/local/libexec/factory-codex/execute

RUN mkdir -p /var/factory-codex/jobs /var/factory-codex/ledger \
    && chmod 0700 /var/factory-codex/jobs /var/factory-codex/ledger \
    && printf '%s\n' \
      'FACTORY_RUNNER_TEMP_ROOT=/home/factory-runner/actions-runner/_work/_temp' \
      'FACTORY_CODEX_HOME=/home/factory-codex' \
      'FACTORY_AGENT_UID=10002' \
      'FACTORY_AGENT_GID=10002' \
      'FACTORY_NODE_BIN=/usr/local/bin/node' \
      > /etc/factory-codex-runner.conf \
    && chmod 0600 /etc/factory-codex-runner.conf \
    && printf '%s\n' \
      'Defaults:factory-runner env_reset,use_pty' \
      'factory-runner ALL=(root) NOPASSWD: /usr/local/libexec/factory-codex/execute *' \
      > /etc/sudoers.d/factory-codex \
    && chmod 0440 /etc/sudoers.d/factory-codex \
    && visudo -c

COPY factory-runner-test/fake-codex.cjs /usr/local/bin/codex
COPY factory-runner-test/harness.mjs /opt/factory-runner-test/harness.mjs
RUN chown root:root /usr/local/bin/codex /opt/factory-runner-test/harness.mjs \
    && chmod 0755 /usr/local/bin/codex && chmod 0644 /opt/factory-runner-test/harness.mjs

USER factory-runner
WORKDIR /home/factory-runner
CMD ["node", "/opt/factory-runner-test/harness.mjs"]

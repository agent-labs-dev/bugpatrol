#!/usr/bin/env bash
# GitHub's Ubuntu runners (and the Playwright image built on Azure) fetch apt
# packages from azure.archive.ubuntu.com. When the runner's resolver cannot find
# that name, every apt step retries for minutes and fails the job, though
# nothing in the commit is wrong. The Ubuntu archive serves the same paths under
# that host name, so point the name at it for this job only.
#
# It changes nothing while the mirror resolves. For `docker build`, which does
# not read the host's /etc/hosts, it exports APT_MIRROR_ADD_HOST for --add-host.
set -euo pipefail

mirror=azure.archive.ubuntu.com
if getent hosts "$mirror" >/dev/null; then
  exit 0
fi

ip=$(getent ahostsv4 archive.ubuntu.com | awk 'NR == 1 { print $1 }')
if [ -z "$ip" ]; then
  echo "::warning::Neither $mirror nor archive.ubuntu.com resolves; apt steps will fail."
  exit 0
fi

echo "::warning::$mirror does not resolve on this runner; using archive.ubuntu.com ($ip)."
echo "$ip $mirror" | sudo tee -a /etc/hosts >/dev/null
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "APT_MIRROR_ADD_HOST=$mirror:$ip" >>"$GITHUB_ENV"
fi

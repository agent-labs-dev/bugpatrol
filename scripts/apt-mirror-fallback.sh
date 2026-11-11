#!/usr/bin/env bash
# GitHub's Ubuntu runners fetch apt packages from azure.archive.ubuntu.com, and
# the Playwright image the runner image builds from names the same mirror. When
# the runner's resolver loses the ubuntu.com names, every apt step retries for
# minutes and fails the job though nothing in the commit is wrong. So any apt
# host the runner cannot resolve is looked up through public DNS over HTTPS and
# pinned in /etc/hosts for this job only.
#
# It changes nothing while the names resolve. `docker build` does not read the
# host's /etc/hosts, so the pins are also exported as APT_MIRROR_ADD_HOSTS, a
# list of --add-host flags.
set -uo pipefail

flags=()
for host in azure.archive.ubuntu.com archive.ubuntu.com security.ubuntu.com; do
  if getent hosts "$host" >/dev/null; then
    continue
  fi
  ip=""
  # DNS over HTTPS: the runner resolves these providers' own names fine.
  for doh in https://cloudflare-dns.com/dns-query https://dns.google/resolve; do
    ip=$(curl -fsS --max-time 10 -H "accept: application/dns-json" "$doh?name=$host&type=A" |
      jq -r '[.Answer[]? | select(.type == 1) | .data][0] // empty')
    [ -n "$ip" ] && break
  done
  if [ -z "$ip" ]; then
    echo "::warning::$host does not resolve here or through public DNS; apt steps that need it will fail."
    continue
  fi
  echo "::warning::$host does not resolve on this runner; pinned to $ip from public DNS."
  echo "$ip $host" | sudo tee -a /etc/hosts >/dev/null
  flags+=("--add-host=$host:$ip")
done

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "APT_MIRROR_ADD_HOSTS=${flags[*]}" >>"$GITHUB_ENV"
fi

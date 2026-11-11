#!/usr/bin/env bash
# Run by the reusable workflows in the author's checkout: installs its dependencies, so its Plugins load (and build),
# then the SDK above the checkout, where a Host provides it, for a Plugin whose own install does not bring it.
#   INSTALL            the author's own install command (the workflow input); else by lockfile
#   FYFLOW_PLUGIN_SDK  the SDK to install above the checkout (default fyflow-plugin-sdk@^0.10.0)
set -euo pipefail

install_here() {
  if [ -f pnpm-lock.yaml ]; then
    if ! command -v pnpm > /dev/null; then
      # The version packageManager names, else the latest (Node 25+ ships no corepack).
      version=$(node -p "((require('./package.json').packageManager || '').match(/^pnpm@([^+]+)/) || [])[1] || ''")
      npm install --global --no-audit --no-fund "pnpm${version:+@$version}"
    fi
    pnpm install --frozen-lockfile
  elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
    npm ci --no-audit --no-fund
  else
    echo "$(pwd): no lockfile, nothing installed"
  fi
}

if [ -n "${INSTALL:-}" ]; then
  echo "+ $INSTALL"
  bash -c "$INSTALL"
else
  install_here
  # A monorepo whose Plugins each have their own lockfile, and no workspace at the root.
  if [ ! -f pnpm-lock.yaml ] && [ ! -f package-lock.json ] && [ -d plugins ]; then
    for dir in plugins/*/; do
      if [ -f "$dir/package-lock.json" ] || [ -f "$dir/pnpm-lock.yaml" ]; then
        (cd "$dir" && install_here)
      fi
    done
  fi
fi

above="${GITHUB_WORKSPACE:-$(dirname "$(pwd)")}"
echo "installing ${FYFLOW_PLUGIN_SDK:-fyflow-plugin-sdk@^0.10.0} in $above/node_modules"
npm install --no-save --no-package-lock --no-audit --no-fund --ignore-scripts --omit=peer --prefix "$above" \
  "${FYFLOW_PLUGIN_SDK:-fyflow-plugin-sdk@^0.10.0}"

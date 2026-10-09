#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE="$(command -v node)"
[[ -z "$NODE" && -x /opt/homebrew/bin/node ]] && NODE=/opt/homebrew/bin/node
"$NODE" scripts/control.mjs tailscale
read "?按回车退出"

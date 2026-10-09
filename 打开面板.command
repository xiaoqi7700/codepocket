#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE="$(command -v node)"
[[ -z "$NODE" && -x /opt/homebrew/bin/node ]] && NODE=/opt/homebrew/bin/node
[[ -z "$NODE" && -x /usr/local/bin/node ]] && NODE=/usr/local/bin/node
if [[ -z "$NODE" ]]; then
  echo "需要 Node.js 22 或更高版本。"; read "?按回车退出"; exit 1
fi
"$NODE" scripts/control.mjs open
if [[ $? -ne 0 ]]; then read "?启动失败。按回车退出"; fi

# 码随行 · CodePocket

> 电脑留在桌上，工作带在身边。Mac 上的 Codex 私有手机控制面板。

手机浏览器查看电脑上的 Codex 项目、历史会话、流式回复、命令输出、文件修改，并恢复会话继续发送指令。电脑执行任务，手机只负责控制。

这是为 macOS 独立实现的面板，不是 Windows 项目的 EXE 移植，也不是官方桌面窗口的网页镜像。

## 使用

需要 Node.js 22+、已配置好的本地 `codex` CLI。无 npm 运行时依赖。

1. 双击 `打开面板.command`，或者执行：

   ```sh
   git clone https://github.com/xiaoqi7700/codepocket.git
   cd codepocket
   node scripts/control.mjs open
   ```

2. 电脑页面打开后，点 **连接手机**，获取地址与面板登录密码。
3. 手机和电脑同 Wi-Fi 时，在手机浏览器打开局域网地址，填写设备名与密码。
4. 在电脑页面 **设备管理** 中核对并批准手机。手机会自动进入。
5. 选择项目或历史会话，发送指令。已有桌面会话被占用时，完全退出桌面客户端再接续原会话，或明确选择复制历史到新会话。

手机浏览器可以“添加到主屏幕”。没有离线缓存会话或 API Key。电脑须保持开机、联网，服务须运行。

## 在外面访问

在 Mac 和手机安装 Tailscale、登录同一个账号，然后双击 `开启跨网络访问.command`。脚本使用 **Tailscale Serve 私网 HTTPS**，没有开启公网 Funnel。按 Tailscale 提示启用 HTTPS；随后在 **连接手机** 中获取 `.ts.net` 地址。

第一次电脑端解锁链接有效 10 分钟、只能使用一次。链接过期后仍可用 `.local/access.txt` 中的密码在本机登录。

## 实现与边界

- 调用现有 `codex app-server --listen stdio://`，继承 `CODEX_HOME`、环境与中转模型配置；不修改 `~/.codex/config.toml` / `auth.json`。
- 不要求官方 ChatGPT 手机配对。网页使用独立面板密码和设备审批。
- 项目读取 Codex 桌面保存的本地项目；历史读取官方 `thread/list`、`thread/turns/list`；恢复使用 `thread/resume`。
- 支持新建会话、历史分页、流式消息、停止任务、命令/文件审批、问题回答与项目文本文件预览。
- 默认项目内读写、按需审批；完整访问需用户在面板主动选择。
- 这是独立 app-server 执行器。桌面即使显示「就绪」也可能继续持有会话写入权，停止生成不等于释放。面板会显示「桌面占用」并保留未发送草稿；继续原会话需完全退出桌面客户端，再点「重新检查占用」。
- 也可显式点击「复制历史到新会话」并确认：只复制目前已保存的历史，创建新的会话 ID；不接管桌面仍在执行的任务、不修改原会话，草稿不会自动发送。防连续点击和同请求幂等处理避免重复创建。
- 不删除锁文件、不强杀桌面进程、不自动换会话。若需要桌面与手机实时操作同一个会话，双方必须使用同一个共享执行器；目前桌面独立 stdio 模式的共享接入未验证。
- 面板完成任务后，在没有其他任务、审批或未提交新会话时，自动退出空闲 Codex 子进程，释放写入权。网页服务本身继续运行；后续读取/发送按需重连。npm 启动器的原生子进程也会被正确识别为面板持有者。
- 回电脑继续时也可在手机面板点「交回桌面」，然后在官方桌面点「重试」。有活动任务或持续目标时不会释放。交回不删除会话、不改会话 ID、不自动发送消息。
- 会话更改持久化在本地 Codex 存储；桌面客户端可能需要重新打开会话后看到更新。
- 设备令牌以 SHA-256 摘要保存；密码认证使用 scrypt；Cookie 为 HttpOnly / SameSite=Strict，HTTPS 下附加 Secure。首次设备须本机批准。密码方便恢复而保存在本机 `0600` 权限文件中。
- 控制服务只允许本机、RFC1918 局域网及 Tailscale 私网地址，校验 Host、Origin、CSRF；不提供任意 RPC 代理或无认证项目接口。
- 局域网 HTTP 不等同端到端加密。在外面或不可信 Wi-Fi 使用 Tailscale HTTPS。首次审批与撤销设备仅限电脑本机管理页面。
- 网页会话读取不显示内部推理内容。文件预览限制在保存的项目根目录，限制真实路径/符号链接，不显示点文件与密钥文件。

## 控制与配置

```sh
node scripts/control.mjs start       # 后台启动，不自动弹浏览器
node scripts/control.mjs open        # 打开电脑管理页面
node scripts/control.mjs status      # 本服务状态
node scripts/control.mjs restart     # 修改代码后的重启
node scripts/control.mjs stop        # 仅停止本面板，不退出官方桌面应用
node scripts/control.mjs tailscale   # 配置私网 HTTPS
npm test                            # 本地自动化测试，不消耗模型额度
```

环境变量：`PANEL_PORT`（默认 47831）、`PANEL_HOST`（默认 0.0.0.0，仍有私网访问限制）、`CODEX_BIN`、`CODEX_HOME`、`PANEL_STATE_DIR`、`TAILSCALE_BIN`。

面板自身的认证、设备、运行标记与日志放在 `.local/`（不提交 Git）。停止任务、撤销设备可在 UI 执行；退出网页不会停止电脑上的任务。不安装开机项、不替换 Codex、不修改用户其他项目文件。

# DeepSeek Harness 桌面版 (dsh-desktop)

双击即可打开 DeepSeek Harness 的 Windows 桌面壳应用。

## 功能

- 双击启动：自动检测 `3080` 端口是否已有 DSH 服务，有则直接复用；否则用内置运行时启动 `dsh web`
- 内置 Node 24.18 运行时 + 完整 DSH 运行时（`resources/dsh`，构建时复制）
- 关闭窗口即完全退出（连子进程树一起清理）
- 支持 `--port <n>` 指定端口
- 支持 `--trusted-host <host>` 等透传参数（见 main.js）

## 使用

```powershell
# 安装依赖
npm install

# 开发运行（需先准备 resources/dsh 运行时）
npm start -- --port 3080

# 构建 Windows 安装包（便携 exe）
& .\build.ps1
```

## 构建说明

`build.ps1` 三步构建：
1. `electron-builder --dir` 生成未打包应用
2. 手动把 DSH 运行时复制进 `win-unpacked\resources\dsh`（绕开 electron-builder 对 `node_modules` 的硬编码排除）
3. `--prepackaged` 封装为 NSIS 安装包

`resources/dsh` 需要从已安装的 DSH 运行时复制（Node 24.x + 完整 node_modules），不入库。

## 日志

运行日志位于 `%APPDATA%\dsh-desktop\dsh-desktop.log`。

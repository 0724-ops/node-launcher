# 内置 Node 运行时（可选）

把随安装包分发的 Node 运行时放在这里，启动器会**优先使用内置运行时**（设置里可切换为优先下载）。

目录命名必须遵循约定，启动器才能识别：

```
resources/runtimes/node-<version>-<platform>-<arch>/     # 例如 node-22.23.3-win32-x64/
├── node.exe            （Windows；其它平台为 bin/node）
├── npm/ …              （Windows；其它平台为 lib/node_modules/npm）
└── node_modules/corepack/…
```

获取方式（首次准备时执行一次，产物不入库）：

```powershell
# 直接解压官方发行包，保持外层目录名不变即可
Invoke-WebRequest https://npmmirror.com/mirrors/node/v22.23.3/node-v22.23.3-win-x64.zip -OutFile node.zip
Expand-Archive node.zip -DestinationPath resources/runtimes
```

- 该目录为空时，启动器会自动按需下载到 `%APPDATA%\node-launcher\runtimes\`，功能不受影响，
  只是首次启动项目需要联网。
- 内置可选是为了离线可用；Windows x64 单个运行时约 80MB（压缩后约 30MB），会显著增大安装包。
- 启动器会对运行时做校验（`node -v` 与 ABI），损坏或版本不符时会忽略并回退到下载路径。

# AG Relay

`logo.png` 取自同一作者的 AG Relay 项目（`src/assets/brand.png`），用于标识喜鹊版。

本插件的错误分类、历史兼容和 SSE 处理移植自 [AG Relay](https://github.com/xinxinxiaoxin/ag-relay) 的 `src-tauri/resources/gateway/relay-retry-proxy.mjs`，原始文件 SHA-256 为 `5772ebcd4ec3357dd9e8dc38bdbf6a902c305e2ffeb64f4d24611ac9ece2ba43`。已改为 Magpie 进程内传输，移除桌面监听与文件日志，并调整请求预算、取消和流式背压。原作者与 MIT 许可全文保存在 `LICENSE`。

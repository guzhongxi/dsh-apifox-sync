# Apifox 接口同步

自动检测 Git 工作区中 Controller、请求 DTO、响应 DTO 和接口说明的改动，在侧边栏列出受影响接口，并在点击确认后增量上传到 Apifox。

上传使用接口和数据模型的“覆盖所有字段”策略，可更新仅发生变化的字段说明；不会删除其他接口，也不会自动上传。请留意：覆盖同步可能替换你在 Apifox 中手工维护的说明、Mock 或示例。

插件复用 `.spring-api-helper.json` 的现有项目配置和令牌，也支持 `APIFOX_ACCESS_TOKEN`、`APIFOX_PROJECT_ID` 环境变量。详细使用方式和当前解析边界见 README。

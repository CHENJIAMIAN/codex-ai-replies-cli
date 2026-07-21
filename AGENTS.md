# 项目记忆

- npm 发布由 `.github/workflows/publish.yml` 自动处理。不要在本地手动运行 `npm publish`。
- 发布流程是：推送版本标签后，发布对应的 GitHub Release；工作流由 `release.published` 触发并执行 `npm publish --provenance`。仅推送标签不会触发该工作流。

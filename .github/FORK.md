# Fork 自动同步与 GHCR 镜像

本 fork 通过 GitHub Actions 每 6 小时同步一次 GitHub 上游
[`zhuweiyou/codearts2api`](https://github.com/zhuweiyou/codearts2api) 的更新，
以合并方式保留本仓库的提交；有冲突时工作流失败，需手动解决，不会强制覆盖。
同步有更新后会直接构建并发布镜像；推送到 `main` 也会自动发布。
Gitee 插件的依赖版本随父仓库的 `package.json` 与锁文件更新。

镜像支持 `linux/amd64` 和 `linux/arm64`，提供 `latest` 与 `sha-<完整提交 SHA>` 标签：

```bash
docker run -d --name codearts2api \
  -p 8080:8080 \
  -v codearts2api-data:/data \
  ghcr.io/sagehou/codearts2api:latest
```

在 fork 的 **Actions** 页面启用工作流后，定时任务即可运行。
也可手动运行 **Sync upstream**（同步并构建，即使没有新提交）或 **Publish image**（仅构建）。
工作流使用内置 `GITHUB_TOKEN`，无需配置额外 Secret；镜像名称会自动使用当前仓库名并转为小写。
首次发布后，如需匿名拉取，在 **Packages → codearts2api → Package settings** 将可见性设为 **Public**。

本 fork 的定制仅新增文件，说明独立放在此处，以减少对上游文件的修改和合并冲突。
未来上游若新增同名文件，仍可能发生合并冲突。
若上游新增或修改 `.github/workflows/**`，GitHub 可能拒绝内置 token 的同步请求，
届时需使用对当前 fork 具有 Contents 和 Workflows 写权限的 PAT。

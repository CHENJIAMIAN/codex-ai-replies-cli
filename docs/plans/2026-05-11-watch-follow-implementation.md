# Watch Follow Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 `cxr` 增加高性能 `--watch` 实时跟随模式，同时保持默认无参输出最近 100 条的行为不变。

**Architecture:** 在 CLI 层新增 `--watch` 参数，启动时仍复用现有 rollout 选择与筛选逻辑输出初始结果。随后锁定同一个 rollout 文件，通过增量读取文件追加内容、解析新增 JSONL，并仅输出新提取出的消息或事件。

**Tech Stack:** Node.js ESM、内置 `fs`、内置 `node:test`

---

### Task 1: 为 `--watch` 写失败测试

**Files:**
- Modify: `test/core.test.js`

**Step 1: Write the failing test**

添加一个 CLI 集成测试：
- 构造一个 rollout 文件，先包含 3 条 assistant 消息
- 以 `--watch --count 2` 启动 CLI
- 断言初始输出只包含最后 2 条
- 运行中向 rollout 文件追加第 4 条 assistant 消息
- 断言 stdout 最终包含新增第 4 条消息

**Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "streams appended rollout messages in --watch mode after printing the latest count"`

Expected: FAIL，因为当前 CLI 还不支持 `--watch`

### Task 2: 实现 `--watch` 参数与跟随主流程

**Files:**
- Modify: `src/cli.js`
- Modify: `src/core.js`

**Step 1: Add CLI option parsing**

在 `src/cli.js` 中：
- 增加 `watch: false`
- 解析 `--watch`
- 更新 help 文案

**Step 2: Add incremental rollout follower**

在 `src/core.js` 中添加基于文件偏移的异步跟随逻辑：
- 接收 rollout 文件路径、初始 entry 数组、提取配置和回调
- 记录当前文件偏移到文件末尾
- 轮询文件大小变化
- 只读取新增片段
- 按完整行解析 JSON
- 将新增 entries 送入现有提取逻辑
- 仅把新增提取项交给回调输出

**Step 3: Wire watch mode in main**

在 `main` 中：
- 保持非 watch 路径不变
- watch 模式先输出初始内容
- 再进入 follower，持续打印格式化后的新增内容

**Step 4: Run focused test**

Run: `npm test -- --test-name-pattern "streams appended rollout messages in --watch mode after printing the latest count"`

Expected: PASS

### Task 3: 补边界测试

**Files:**
- Modify: `test/core.test.js`

**Step 1: Add default-count watch test**

增加测试验证 `--watch` 未显式传 `--count` 时，初始输出仍遵循默认 100 条截断。

**Step 2: Verify red-green if needed**

如果测试暴露边界问题，先确认失败，再补最小实现。

**Step 3: Run focused watch tests**

Run: `npm test -- --test-name-pattern "watch mode"`

Expected: PASS

### Task 4: 更新文档

**Files:**
- Modify: `README.md`
- Modify: `src/cli.js`

**Step 1: Document watch mode**

在 `README.md` 的 Quick Start、Command Reference 和说明段落中加入 `--watch` 示例和语义说明。

**Step 2: Keep docs aligned with help**

确保 help 文案、README 选项描述一致。

### Task 5: 全量验证并发布

**Files:**
- No new code files

**Step 1: Run verification**

Run:
- `npm test`

Expected: 全部通过

**Step 2: Commit**

Run:
- `git add docs/plans/2026-05-11-watch-follow-design.md docs/plans/2026-05-11-watch-follow-implementation.md test/core.test.js src/cli.js src/core.js README.md`
- `git commit -m "feat: 增加 cxr 实时跟随模式"`

**Step 3: Push**

Run:
- `git push origin master`

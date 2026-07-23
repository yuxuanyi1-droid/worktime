# 测试目录

本目录是项目所有自动化用例、测试辅助代码、恢复演练与性能测试脚本的唯一存放位置。

- [功能覆盖矩阵](./COVERAGE_MATRIX.md)：逐功能对应前后端测试与已验证行为。
- [完整代码审查报告](./REVIEW_REPORT.md)：设计、交互、安全、缺陷修复和剩余联调边界。

## 目录结构

- `server/`：后端单元测试、集成测试与测试数据库辅助代码。
- `client/`：前端组件、Hook、状态管理与交互测试。
- `config/`：Vitest 的前后端独立配置。
- `performance/`：只读和写入压力测试、负载均衡及资源监控脚本。
- `recovery/`：队列恢复和故障接管演练。
- `smoke/`：面向已启动完整环境的端到端烟测，默认不输出令牌和业务数据。
- `coverage/`：本地生成的覆盖率报告，已忽略提交。

## 常用命令

```bash
npm test
npm run test:server
npm run test:client
npm run test:coverage
npm run test:smoke:ai
npm run test:perf:reads -- 100 1000
```

客户端用例会按文件分批在隔离进程中执行，覆盖率命令会在
`tests/coverage/client/` 自动合并各批次结果；这样可避免 Ant Design 页面全集在
WSL 或小内存 CI 中产生过高的单进程内存峰值。

性能脚本默认面向已启动的完整环境。`stress-timesheet-submit.mjs`、
`stress-same-week-submit.mjs` 和 `stress-submit-approve.mjs` 会写入持久化数据，
只能对一次性测试数据库执行；运行前必须确认 `BASE_URL` 指向测试环境。

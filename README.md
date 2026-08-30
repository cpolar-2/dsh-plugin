# dsh-usage-stats

DeepSeek Harness 应用用量统计插件:在 Web 界面提供一个独立的 `使用统计` 仪表盘页面(截图同款布局),展示:

- **统计卡片**:累计 Token 数、峰值(单日)Token 数、最长聊天时长、当前连续天数、最长连续天数
- **Token 活动**:GitHub 风格全年热力图,支持 每日 / 每周 / 累计 三种着色模式
- **每日 Token 趋势图**:按模型分线的平滑曲线,近 7 日 / 近 30 日切换
- **模型用量**:环形占比图 + 各模型 token 明细

同时提供前端入口:client 面在侧边栏底部(设置按钮旁)注册「使用统计」按钮,点击新标签页打开仪表盘。

<img width="1023" height="574" alt="image" src="https://github.com/user-attachments/assets/bb5c6616-97f5-4a74-9079-0f77bb275961" />

<img width="1011" height="672" alt="image" src="https://github.com/user-attachments/assets/c310d861-92a5-4f3b-a94f-d781304088a0" />
<img width="1184" height="439" alt="image" src="https://github.com/user-attachments/assets/21c6cf18-f429-40a7-bf25-f4398636b7f6" />

## Install

```bash
# 从本地路径安装(开发)
dsh plugin --profile web add H:/deepseek-harness/dsh-plugin/dsh-usage-stats

# 或不打包直接预览:把 cordis.patch.yml 里的 name 保持为 dsh-usage-stats,
# 并确保该路径可被 Node 解析(profile node_modules 或 pnpm link)。
```

安装后重启 `dsh web`,浏览器打开 `http://127.0.0.1:<port>/usage-stats`。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖(可省略):

```yaml
- insert:
    - id: usage-stats
      name: dsh-usage-stats
      config:
        keepDays: 400   # 账本保留天数(默认 400,超出自动清理)
```

## 开发

```bash
npm test                  # node --test,账本/汇总/采集器单元测试
node scripts/preview.mjs  # 注入演示数据并在 8787 端口起一个预览服务
```

预览脚本使用隔离的临时 `$DSH_HOME`,不会读写真实账本。

## 口径说明

- Token 总量 = input + output + cacheRead + cacheWrite + reasoning(与 dsh-cost-meter 记账桶一致)。
- 「峰值 Token 数」= 单日最高总量;「最长聊天时长」= 单会话内首末模型请求的活动跨度;
  「当前连续天数」今天尚未使用时不断签(从昨天回数)。
- 若与 dsh-cost-meter 同时使用,两者各自独立记账,互不影响。

## License

MIT

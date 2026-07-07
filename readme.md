# agentblume

ノーコードでAIエージェントを組み立て・実行・検証するためのローカルIDE。ETLツールエンジンを中心に、エージェント／スキル／ツールの定義、動作確認、検証を1つのUIから行える。

- **スタック**: TypeScript / React 19 / Fastify / Vite / Vitest / Playwright
- **状態**: プレビュー（ローカル実行向け）

## ローカル開発

PowerShellからAPIとUIをまとめて起動する。

```powershell
.\scripts\start-dev.ps1
```

既定はAPI `3030`、UI `5173`。使用中の場合は既存プロセスを自動停止せず、起動前にエラーを返す。別ポートで起動する場合:

```powershell
.\scripts\start-dev.ps1 -ApiPort 3031 -UiPort 5174
```

主なオプション:

- `-Profile local|test`
- `-ApiOnly` / `-UiOnly`
- `-ApiPort <1-65535>` / `-UiPort <1-65535>`
- `-DryRun`: 子プロセスを起動せず、実行予定のコマンドと接続先を表示する。

テストと検証:

```powershell
npm test
npm run test:e2e
npm run typecheck
npm run build
```

## ライセンス

[MIT License](LICENSE) © 2026 yy7613


# 運用制約

AI-DE × Orca 統合プログラムで共通に適用する fork、worktree、秘密情報、検証、報告の境界を定める。

- 作業は fork 内で完結する。stablyai/orca への PR・push・comment を一切行わない。`gh` は常に `--repo` を明示する（fork clone では既定が親リポジトリになる）
- `/home/atsou/src/github.com/TomyFovos/Orca` では branch 切替・rebuild・`git pull` を行わない。`orca-serve.service` がこの作業ツリーから動いている
- リポジトリ設定（branch protection 等）の変更は利用者のみが行う
- `AI_DE_ISSUE9_PREFLIGHT_PROVEN` を `'true'` にしない
- `reviewer-role-registry.js` の `recordPath()` に触れない（#9 の境界・#74 の scope）
- 署名秘密鍵は worker プロセスから到達可能にしない。コミットしない。環境変数が運ぶのはパスであって鍵素材ではない
- `test-` 接頭辞の authority を production registry に登録しない
- 秘密情報（`.env`・鍵・トークン・`.ai-de-vault`・masking の実値）は読まない・出力しない
- 作業セッションは `git push` / PR 作成 / `gh` の書き込み系（`issue comment`、`pr create`、`issue edit`）を行わない。commit までで止めて統括へ報告する。push と PR は統括が行う
- `git push` / `reset --hard` / `clean` / `docker compose down` / `sudo` / 再帰削除は確認なしに実行しない
- `main` へ直接コミットしない。必ずブランチを切る（branch protection は直 push を止めない）
- 報告にソースコードを貼らない。パスと行番号、スキーマ名で示す
- 失敗した実行の生成物は、原因が確定するまで teardown しない
- 拒否経路は「なぜ拒否したか」を必ず記録する。fail-closed の要件の半分である

## 確定済みの裁定

- マージ基準は部分集合判定。PR の失敗集合が `origin/main` の失敗集合の部分集合であること。数だけの報告は受け付けない
- GitHub-hosted Actions の実行枠枯渇を理由に CI を実施しない旧方針は終了した。fork の標準回帰 CI は、下記の安全条件を満たす認可済み self-hosted runner で実行する。マージ前のローカル全項目検証も引き続き必須で、実行コマンドと出力を PR 本文へ記録する
- PR の base を必ず確認する。既にマージ済みの branch を base にすると成果が `main` へ着地しない（orca PR #8/#9 で実際に発生した）

## Fork self-hosted 回帰 CI

`.github/workflows/self-hosted-regression.yml` は、fork の `main` への push、fork 内の `main` 向け PR、または `workflow_dispatch` で回帰テストを実行する標準 CI workflow である。既存の大規模 upstream workflow は upstream 製品の責務を保つため変更せず、特権処理や Linux 以外の OS 固有検証を永続 self-hosted runner へ混在させない。

- runner は確認済みラベル `self-hosted`, `Linux`, `X64` を持つ `github-runner-orca` 認可済み環境に限定する。concurrency group は repository・workflow・ref ごとに分離し、同じ ref の古い実行はキャンセルする。job timeout は 90 分とする
- job-level の条件 `github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository` を必須とし、外部 fork の PR では永続 runner を絶対に使用しない
- checkout は `clean: true`、完全履歴、`persist-credentials: false` で行う。追加した外部 Actions は完全な commit SHA (`actions/checkout` と `actions/upload-artifact`) で固定する
- Node と pnpm は `package.json` の `engines` / `packageManager` を基準に、既存の `.github/actions/install-node-dependencies` local action (`native-runtime: node`) で準備する。local action の既存設定は変更しない
- `pnpm test` の標準出力と標準エラーは `set -euo pipefail` と `tee` で `$RUNNER_TEMP/orca-regression-tests.log` に保存し、テスト失敗をパイプで隠さない。ログは `always()` の artifact upload で 14 日保持する
- Issue #65 に R71 の保持開始を記録していない状態では full suite を手動 dispatch しない
- 受入れ判定は引き続き R34（head の失敗集合が base の部分集合）、R52（full suite ×3、head/base 交互、無負荷）、R61（専有 worktree）、R71（full suite 保持を一つに限定）に従う。`config/tsconfig.tc.web.json` の既知の TS6307 ×2 は base/head の失敗集合比較で扱い、新規失敗を許容しない

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
- GitHub Actions の実行枠は今月分が尽きている。CI は走らない。マージ前のローカル全項目検証を必須とし、実行コマンドと出力を PR 本文へ記録する
- PR の base を必ず確認する。既にマージ済みの branch を base にすると成果が `main` へ着地しない（orca PR #8/#9 で実際に発生した）

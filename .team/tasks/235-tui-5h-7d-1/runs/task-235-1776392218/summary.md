# T235 — TUI ヘッダー 5h/7d の間にスペース 1 つ分の間隔を開ける

## 変更内容

`skills/cmux-team/manager/dashboard.tsx` のレート制限バー描画で、group 内（bar と remaining time の間）に 1 スペースを挿入。

### 描画結果の変化

修正前: `5h: 42% ████░░░░░░5h  7d: 17% ██░░░░░░░░7d`
修正後: `5h: 42% ████░░░░░░ 5h  7d: 17% ██░░░░░░░░ 7d`

bar と残り時間（gray）の間に 1 スペース、group 間の 2 スペースは従来通り維持。

## 変更ファイル

- `skills/cmux-team/manager/dashboard.tsx`（2 箇所）
  - 右側テキストの幅計算ロジック（line 932）
  - 非 throttled パスの ui.row 描画（line 952）

throttled パスは既に全パーツ間に 2 スペースが入っているため変更不要。

## テスト結果

- `bun test skills/cmux-team/manager/rate-limit-display.test.ts`: 9 pass / 0 fail

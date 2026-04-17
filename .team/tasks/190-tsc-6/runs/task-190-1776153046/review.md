# T190 Design Review

## 判定: Approved

## 所見

- **tsc エラー6件の同定は完全一致**: 実際に `bunx tsc --noEmit` を走らせた結果、plan.md が挙げる 6 件と一対一で対応した（cmux.ts:22, daemon.ts:20, dashboard.tsx:373, dashboard.tsx:1000, main.test.ts:84, main.ts:515）。過不足なし。
- **各修正の型整合性は妥当**:
  - `cmux.ts:22` の destructure + `.toString()`: `execFile` は encoding 未指定時 string を返すため実行時 no-op。将来 Buffer が返るケースでも安全側に倒れる。問題なし。
  - `main.test.ts:84` の `m[1]!`: 直前の `if (!m) throw` により capture group 1 の存在は保証されている。テストコードでの non-null assertion は許容範囲。
  - `main.ts:515` の `?? undefined`: `cmux.renameWorkspace` は内部で `if (workspace) args.push(...)` と truthy チェック（cmux.ts:120）しているため、null / undefined の挙動差はゼロ。安全。
  - `dashboard.tsx:373, 1000` の `dsVariant: "unstyled"` 削除: `WidgetVariant = "solid" | "soft" | "outline" | "ghost"` に "unstyled" は含まれず、runtime バリデータは undefined 相当として扱う。プロパティ削除で runtime 挙動は不変という主張は正しい。
- **`@types/update-notifier` のバージョン**: DefinitelyTyped は `@types/update-notifier@6.0.x` で `update-notifier@6` をターゲット（本プロジェクトは `update-notifier@^7.0.0`）。メジャーが1つずれるが、update-notifier v7 は主に ESM 化が変更点で型 API 自体はほぼ不変であり、`updateNotifier(opts).notify()` の既存用法なら `^6.0.8` で実用上問題ない見込み。install 後に仮に型エラーが残れば `declare module "update-notifier"` の ambient 宣言でフォールバック可能だが、現時点で plan の選択（`^6.0.8`）は妥当。install 後に tsc で再確認する点は検証手順に含まれているため OK。
- **実行時挙動への影響ゼロ**: 全 6 箇所とも型注釈レベル。リスク評価「低」は適切。
- **見落としなし**: 副作用のある書き換え（フロー変更・エラーハンドリング変更・依存削除）は一切ない。検証手順（install → tsc → test → git diff 確認）も十分。
- **変更スコープの明瞭さ**: package.json + bun.lock + 6 箇所のピンポイント変更のみ、という境界が明示されており、Implementer が迷う余地がない。

## Recommendations

なし（Approved）。

補足（任意）: `dsVariant: "unstyled"` は過去に「意図的に装飾を外す」記述として使われていた可能性がある。削除しても runtime は不変だが、レビュー者が「なぜ外したか」を追えるようにコミットメッセージ本文で「'unstyled' は WidgetVariant に存在せず runtime では undefined と同義のため削除」と 1 行触れておくと将来の blame 時に親切。必須ではない。

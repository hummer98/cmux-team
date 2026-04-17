---
id: A011
type: research
title: "cmux list-status が tree と同じ deadlock 経路を通るかのソースコード調査"
created: 2026-04-15T06:19:54+09:00
author: master
task: T175
tags: [cmux, deadlock, list-status, tree, research, upstream]
---

## 目的

cmux 本家 issue #2586 で報告された SwiftUI サイドバー LazyVStack のレイアウトループによる main thread 占有 → CLI 側 `DispatchQueue.main.sync` 永久ブロックの deadlock について、修正 PR #2601 (v0.63.2 同梱) 適用後も `cmux tree` のフリーズが当方環境で発生している。cmux-team で `cmux tree` を `cmux list-status` に置き換える案があるが、両者が同じ main-thread 経由のブロッキング呼び出しを共有しているならば置き換えても deadlock は解消しない。本調査では v0.63.2 のソースコードレベルで両コマンドの実行経路を追い、`DispatchQueue.main.sync` を経由するかを判定する。

## 結論（先に結論）

- **Yes（部分的にではなく完全に）** — `list-status` は `tree` と**同じ deadlock 経路**を通る。両者ともサーバ側で `DispatchQueue.main.sync` を呼ぶため、SwiftUI の main thread が LazyVStack 等のレイアウトループでスタックしている間は両コマンドとも応答できない。
- **根拠**: `list-status` は `TerminalController.listSidebarMetadata` の中で `DispatchQueue.main.sync { ... }` を直接呼ぶ（`Sources/TerminalController.swift:14781`）。`tree` は `v2SystemTree` の中で `v2MainSync { ... }` 経由で同じく `DispatchQueue.main.sync(execute: body)` を呼ぶ（`Sources/TerminalController.swift:2771`, `2964`）。PR #2601 はこの 2 関数を**一切変更していない**（mutation 系コマンドのみを `.async` 化した）。
- **推奨**: `cmux tree` → `cmux list-status` への置き換えは **deadlock 回避策にはならない**。フリーズが残っている本当の原因は LazyVStack 以外にも main thread を占有する要因が残っているか、あるいは `clearAll`/`clearNotifications` 以外の経路で main-sync を呼ぶ箇所があると考えるのが自然。`read-screen` も同様に `DispatchQueue.main.sync` を呼ぶ（`Sources/TerminalController.swift:11318`）ため避けられない。当面は (a) v0.63.3+ がリリースされていないか定期確認、(b) フリーズ検出時にタイムアウトでフォールバックする運用、(c) issue として cmux 本家へ「v0.63.2 でも tree がフリーズする再現手順」を追加報告、のいずれかが現実的。

## list-status のコードパス

### CLI 側エントリーポイント

`CLI/cmux.swift:2576-2583` — `list-status` サブコマンドは `forwardSidebarMetadataCommand` 経由で V1 ソケットコマンド `list_status` をサーバへ送る。

```swift
// CLI/cmux.swift:2576
case "list-status":
    let response = try forwardSidebarMetadataCommand(
        "list_status",
        commandArgs: commandArgs,
        client: client,
        windowOverride: windowId
    )
    print(response)
```

`forwardSidebarMetadataCommand`（`CLI/cmux.swift:8823-8872`）は引数を整形して `sendV1Command(command, client:)` を呼ぶ。これはテキストプロトコル（改行区切り）でソケットへ書き込み、応答を 1 行で読む単純なラッパー。

```swift
// CLI/cmux.swift:3111
private func sendV1Command(_ command: String, client: SocketClient) throws -> String {
    let response = try client.send(command: command)
    if response.hasPrefix("ERROR:") {
        throw CLIError(message: response)
    }
    return response
}
```

### サーバ側ハンドラ

`Sources/TerminalController.swift:1787` — V1 コマンドディスパッチで `list_status` → `listStatus(args)`。

```swift
// Sources/TerminalController.swift:1787
case "list_status":
    return listStatus(args)
```

`listStatus` は `listSidebarMetadata` の薄いラッパー（`Sources/TerminalController.swift:14818`）。

```swift
// Sources/TerminalController.swift:14818
private func listStatus(_ args: String) -> String {
    listSidebarMetadata(args, emptyMessage: "No status entries")
}
```

そして `listSidebarMetadata` の中身：

```swift
// Sources/TerminalController.swift:14779
private func listSidebarMetadata(_ args: String, emptyMessage: String) -> String {
    var result = ""
    DispatchQueue.main.sync {                         // ← ★ ここで main にブロッキング
        guard let tab = resolveTabForReport(args) else {
            result = "ERROR: Tab not found"
            return
        }
        let entries = tab.sidebarStatusEntriesInDisplayOrder()
        if entries.isEmpty {
            result = emptyMessage
            return
        }
        result = entries.map(sidebarMetadataLine).joined(separator: "\n")
    }
    return result
}
```

このコマンドを処理する worker thread は `acceptLoop`（`Sources/TerminalController.swift:1322`、`nonisolated func` → 必ず非 main で動く）から派生したソケットハンドラ。したがって main thread が SwiftUI レイアウトループで占有されている間、この `DispatchQueue.main.sync` は永久に待つ。

## tree のコードパス

### CLI 側エントリーポイント

`CLI/cmux.swift:2133-2134` — `tree` は専用のヘルパ `runTreeCommand` を呼ぶ。

```swift
// CLI/cmux.swift:2133
case "tree":
    try runTreeCommand(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput, idFormat: idFormat)
```

`runTreeCommand`（`CLI/cmux.swift:8908`）→ `buildTreePayload`（`CLI/cmux.swift:8955`）→ `client.sendV2(method: "system.tree", params: params)`。`system.tree` が未対応の古いサーバには `buildLegacyTreePayload` でフォールバックし、`window.list` / `workspace.list` 等を順次 `sendV2` で呼ぶ。

```swift
// CLI/cmux.swift:8970
do {
    let payload = try client.sendV2(method: "system.tree", params: params)
    return treePayloadWithMarkers(payload)
} catch let error as CLIError where error.message.hasPrefix("method_not_found:") {
    return try buildLegacyTreePayload(options: options, params: params, client: client)
}
```

### サーバ側ハンドラ

`Sources/TerminalController.swift:2060-2061` — V2 ディスパッチで `system.tree` → `v2SystemTree(params:)`。

```swift
// Sources/TerminalController.swift:2060
case "system.tree":
    return v2Result(id: id, self.v2SystemTree(params: params))
```

`v2SystemTree` の本体（`Sources/TerminalController.swift:2752` 以降）。実際に AppDelegate / TabManager をたどって window/workspace ツリーを組み立てる部分は `v2MainSync { ... }` で囲まれている。

```swift
// Sources/TerminalController.swift:2771
v2MainSync {
    guard let app = AppDelegate.shared else { return }
    let summaries = app.listMainWindowSummaries()
    // ... tabManager.tabs を読み、Workspace / Pane / Surface ノードを構築
}
```

`v2MainSync` の定義：

```swift
// Sources/TerminalController.swift:2960
private func v2MainSync<T>(_ body: () -> T) -> T {
    if Thread.isMainThread {
        return body()
    }
    return DispatchQueue.main.sync(execute: body)        // ← ★ tree でも main にブロッキング
}
```

`acceptLoop` 経由で来る worker thread は `Thread.isMainThread == false` なので、必ず `DispatchQueue.main.sync` パスを通る。

## 共通経路の特定

両コマンドが共有する経路：

1. **CLI → サーバ**: 同じ Unix domain socket、同じ `acceptLoop`（`Sources/TerminalController.swift:1322`）が立てる worker thread でハンドラを実行。
2. **main thread への同期ホップ**:
   - `list-status`: `Sources/TerminalController.swift:14781` の `DispatchQueue.main.sync` を**直接**呼ぶ。
   - `tree`: `Sources/TerminalController.swift:2771` の `v2MainSync` 経由で `Sources/TerminalController.swift:2964` の `DispatchQueue.main.sync(execute: body)` を呼ぶ。
3. **どちらも main thread が応答しない限り完了しない**。SwiftUI の `VerticalTabsSidebar` が `LazyVStack` のレイアウトループで RunLoop を回さなくなっていれば、両方とも 15 秒の `responseTimeoutSeconds`（`CLI/cmux.swift:864` 周辺）にかかってタイムアウト or ハング。

なお issue #2586 で言及されていた `clearNotifications` 経路は v0.63.2 で `DispatchQueue.main.async` に変更されており、もはや **mutation** 系の clear/set コマンドは sync ではない。しかし **read** 系（`list_status`, `list_meta`, `list_log`, `read_screen`, `system.tree`, `window.list` 等）は依然として sync のままで、これらは値を返す必要があるため async 化が困難。

## PR #2601 の修正内容と影響

PR #2601 (`gh pr diff 2601 --repo manaflow-ai/cmux`) の主な変更は 3 種類：

1. **CLI 側のソケット書き込みタイムアウト強化** (`CLI/cmux.swift`) — `SO_SNDTIMEO`, `SO_NOSIGPIPE` を設定し、書き込みが永久にブロックしないようにする。EAGAIN/EWOULDBLOCK/ETIMEDOUT を専用エラーに変換。これはハング時に CLI 側が**より早く諦める**ためのもので、サーバ側 deadlock を防ぐものではない。
2. **SwiftUI サイドバーの `LazyVStack` → `VStack` 置換** (`Sources/ContentView.swift:9929`) — タブが有限個 (bounded) のため非 lazy stack で十分という根拠でレイアウトループを断ち切る。コメント `"LazyVStack + drag-state invalidations can recurse through layout."` あり。これが本来の **根本治療**。
3. **mutation 系コマンドの `DispatchQueue.main.sync` → `.async` 化** (`Sources/TerminalController.swift`) — `v2NotificationClear` (line 6913)、`clearNotifications` (line 12741)、`clearStatus`、`set_agent_pid`、`clear_agent_pid`、`reportMetaBlock` 等の mutation を `scheduleSidebarMutation(target:mutation:)` 経由で非同期化。
   - 戻り値が単純な "OK" になるものは async 化できる。
   - 一方で **値を返す必要のある read 系**（`listSidebarMetadata`, `v2SystemTree`, `readTerminalTextBase64` 等）は **手付かず**。

PR #2601 が **触っていない** ことの確認：

```
$ gh pr diff 2601 --repo manaflow-ai/cmux | grep -E "(listSidebarMetadata|listStatus|v2SystemTree|v2MainSync)"
(no output)
```

つまり `tree` も `list-status` も、**実装そのものは v0.63.1 と v0.63.2 で同一**。改善されたのは「LazyVStack 起源のレイアウトループ」を取り除いた点と、mutation 系を main をブロックしない形に変えた点の 2 つ。`tree` のフリーズが v0.63.2 でも残っているのなら、それは **LazyVStack 以外に main thread を占有する要因** がまだあることを意味する（drag delegate の他のパス、別の View の更新、外部要因など）。`list-status` に置き換えても同じ要因に同じく刺さる。

## 制約と未解決の疑問

- v0.63.2 タグの `Sources/TerminalController.swift` は 15833 行ある。`DispatchQueue.main.sync` だけで 70 箇所以上ヒットする（前述の grep 出力参照）。本調査では `list-status` と `tree` の 2 経路に絞ったため、両者が共有する**他の隠れた main-sync ホップ**（例えば `withSocketCommandPolicy` 内の前処理）は精査していない。重要なのは「両者ともメインスレッド ブロッキングを少なくとも 1 回は経由する」という事実で、これは確定。
- 「v0.63.2 で tree がフリーズする」の **再現条件** は本調査の対象外。サイドバーが LazyVStack でなくなった後でも main を占有する要因がある可能性として候補は (a) `SidebarTabDropDelegate` の他のメソッド、(b) `ContentView` 内の別の `@MainActor` 重い処理、(c) AppKit 側のモーダル/メニュー、(d) ghostty embedding の同期描画 等が考えられるが、再現手順なしに特定はできない。
- `runTreeCommand` が古いサーバ向けに `buildLegacyTreePayload` で `window.list` / `workspace.list` を順次呼ぶ点は、v0.63.2 サーバでは通らない（`system.tree` がサポートされている）。フォールバック経路でフリーズしているわけではないと判断。
- PR #2601 マージ後に v0.63.3 以降の commit がさらに deadlock を改善した可能性は本調査では未確認（v0.63.2 タグでチェックアウト固定）。upstream `main` ブランチを別途確認する価値はある。

## 参考リンク

- issue #2586: https://github.com/manaflow-ai/cmux/issues/2586
- PR #2601: https://github.com/manaflow-ai/cmux/pull/2601
- ソース: `manaflow-ai/cmux` tag `v0.63.2`
  - `CLI/cmux.swift:2133` (tree dispatch), `:2576` (list-status dispatch), `:8908` (`runTreeCommand`), `:8955` (`buildTreePayload`), `:8823` (`forwardSidebarMetadataCommand`), `:3111` (`sendV1Command`)
  - `Sources/TerminalController.swift:1322` (`acceptLoop`, `nonisolated`), `:1787` (V1 `list_status` dispatch), `:2060` (V2 `system.tree` dispatch), `:2752` (`v2SystemTree`), `:2960` (`v2MainSync`), `:14779` (`listSidebarMetadata`), `:14818` (`listStatus`), `:11313` (`readTerminalTextBase64` — `read-screen` も同じ問題)
- ローカルクローン: `/tmp/cmux-source` (HEAD detached at v0.63.2)

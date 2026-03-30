---
id: 018
title: SQLite FTS5 トレースストアの実装
priority: high
created_at: 2026-03-29T10:59:07.139Z
---

## タスク
## 概要
Bun 内蔵 SQLite を使い、トレースのメタデータ + 全文検索索引を管理するモジュールを新規作成する。

## 新規ファイル
- skills/cmux-team/manager/trace-store.ts

## スキーマ

```sql
CREATE TABLE traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  conductor_id TEXT,
  role TEXT,
  method TEXT,
  path TEXT,
  status INTEGER,
  request_bytes INTEGER,
  response_bytes INTEGER,
  duration_ms INTEGER,
  request_body_path TEXT,  -- .req.json へのパス
  response_body_path TEXT  -- .res.json へのパス
);

CREATE VIRTUAL TABLE traces_fts USING fts5(
  task_id, conductor_id, role, request_summary, response_summary,
  content=traces, content_rowid=id
);
```

## 実装する関数
1. initDB(projectRoot): DB 初期化 + テーブル作成
2. insertTrace(entry): トレース登録 + FTS5 索引更新
3. searchTraces(query, filters): メタデータフィルタ + 全文検索
4. getTrace(id): 個別トレース取得（本文パス含む）

## 注意
- Bun.sqlite を使用（import { Database } from 'bun:sqlite'）
- DB ファイル: .team/traces/traces.db
- request_summary / response_summary は本文の先頭 1000 文字程度を格納（FTS5 用）
- 本文全体は bodies/ の JSON ファイルを参照

## 関連
- Issue #15
- タスク 016（Proxy から呼び出される）

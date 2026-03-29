---
id: 039
title: Manager コードベースの any 型使用箇所を調査し Zod スキーマで正規化する
priority: medium
status: ready
created: 2026-03-29
---

## 概要

Manager の TypeScript コードベースで `any` 型や型安全でないパターンが使われている箇所を洗い出し、Zod スキーマによるバリデーション・型推論に置き換える。

## 調査対象

- `skills/cmux-team/manager/*.ts` 全ファイル
- 既に `schema.ts` と `zod` 依存が存在するので、それを活用する

## 確認ポイント

1. 明示的な `any` 型の使用箇所
2. `as` による型アサーション（unsafe cast）
3. JSON.parse の戻り値を型チェックなしで使用している箇所
4. 外部入力（ファイル読み込み、cmux コマンド出力、キューメッセージ）のバリデーション不足
5. 既存の `schema.ts` の Zod スキーマが実際に使われているか

## 成果物

- any 使用箇所の一覧と修正（Zod スキーマによるパース/バリデーションへの置換）
- 必要に応じて `schema.ts` にスキーマを追加

## 影響範囲
- skills/cmux-team/manager/*.ts

/**
 * `cmux-team token` サブコマンド群（T319）。
 *
 * token add | list | remove | rotate | set-plan
 *
 * token-store.ts（T318）が提供する tokens.db / Keychain CRUD を利用する。
 */

import { createInterface } from "readline";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import {
  initTokenDB,
  insertToken,
  listTokens,
  getTokenByHandle,
  getLatestUsageSnapshot,
  storeTokenInKeychain,
  retrieveTokenFromKeychain,
  deleteTokenFromKeychain,
  isKeychainSupported,
  readClaudeCodeKeychain,
  updateTokenPromoteFields,
  KeychainUnsupportedError,
  type CredentialSource,
  type TokenPlan,
} from "./token-store";
// T323: 共有フォーマッタを token-format.ts に切り出し（pool-cli.ts と再利用）
// T390: per-handle 行は formatPerHandleUtilCell に切り替え（effUtil 表示 + reset 通過マーカー）
import { formatReset, formatSelectable, formatPerHandleUtilCell } from "./token-format";

// ─────────────────────────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

function computeAuthHash(token: string): string {
  return createHash("sha256").update(`Bearer ${token}`).digest("hex").slice(0, 12);
}

const PLAN_MAP: Record<string, { plan: TokenPlan; ratio: number }> = {
  default_claude_max_20x: { plan: "max-x20", ratio: 20.0 },
  default_claude_max_5x: { plan: "max-x5", ratio: 5.0 },
  default_claude_pro: { plan: "pro", ratio: 1.0 },
};

// T349: plan 名 → {plan, ratio} の逆引き。手入力された plan の検証に使う。
// 真実は PLAN_MAP に一本化し、ここでは値を再利用する（キーは静的に存在するので `!` で narrow）。
const PLAN_BY_NAME: Record<string, { plan: TokenPlan; ratio: number }> = {
  pro: PLAN_MAP.default_claude_pro!,
  "max-x5": PLAN_MAP.default_claude_max_5x!,
  "max-x20": PLAN_MAP.default_claude_max_20x!,
};

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

/**
 * 登録時の plan / plan_ratio を解決する（T349）。
 *
 * - rateLimitTier が `PLAN_MAP` に存在すれば即解決し、`rateLimitTier: ... → plan: ...` を
 *   1 行ログ出力する。
 * - rateLimitTier が undefined もしくは `PLAN_MAP` に未登録の場合は対話 prompt で
 *   plan を尋ねる。空 Enter で `unknown`。
 *
 * `Found credential:` ブロックと plan prompt の間の空行も helper 内で出力する。
 * 呼び出し側は `Found credential:` / `organizationId:` を出し、本関数を呼ぶだけ。
 */
async function resolvePlanForRegistration(
  rl: ReturnType<typeof createInterface>,
  rateLimitTier: string | undefined,
): Promise<{ plan: TokenPlan; planRatio: number | null }> {
  const fromTier = rateLimitTier ? PLAN_MAP[rateLimitTier] : undefined;
  if (fromTier) {
    console.log(
      `  rateLimitTier: ${rateLimitTier}  → plan: ${fromTier.plan} (ratio ${fromTier.ratio.toFixed(1)})`,
    );
    return { plan: fromTier.plan, planRatio: fromTier.ratio };
  }
  console.log("");
  return promptManualPlan(rl);
}

/**
 * plan を手入力で確定させる（T349）。空 Enter で `unknown`。
 * 不正値は再入力させる。
 */
async function promptManualPlan(
  rl: ReturnType<typeof createInterface>,
): Promise<{ plan: TokenPlan; planRatio: number | null }> {
  for (;;) {
    const ans = (await prompt(rl, "plan (pro / max-x5 / max-x20, Enter で unknown): ")).trim();
    if (ans === "") return { plan: "unknown", planRatio: null };
    const entry = PLAN_BY_NAME[ans];
    if (entry) return { plan: entry.plan, planRatio: entry.ratio };
    console.error(
      "Error: pro / max-x5 / max-x20 のいずれかを入力してください（空 Enter で unknown）",
    );
  }
}

/**
 * `claudeAiOauth.accessToken` を抽出する。
 * raw 文字列が JSON として無効、もしくは `accessToken` が無ければ null。
 */
function parseClaudeCredentialJson(raw: string): {
  accessToken: string;
  rateLimitTier: string | undefined;
} | null {
  try {
    const obj = JSON.parse(raw);
    const oauth = obj?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      rateLimitTier: oauth.rateLimitTier,
    };
  } catch {
    return null;
  }
}

/**
 * Claude Code の credential を取得する（T345）。
 * 優先順位:
 *   1) macOS Keychain (`Claude Code-credentials` / account=$USER)
 *   2) `~/.claude/.credentials.json`
 * いずれも JSON 破損 / `claudeAiOauth.accessToken` 欠損であれば次の経路へ fallback する。
 */
async function readClaudeCredentials(): Promise<{
  accessToken: string;
  rateLimitTier: string | undefined;
} | null> {
  const keychainJson = readClaudeCodeKeychain();
  if (keychainJson) {
    const parsed = parseClaudeCredentialJson(keychainJson);
    if (parsed) return parsed;
    // JSON 破損 / accessToken 欠損 → file fallback（warn は出さない: 期待される fallback）
  }

  const credPath = join(homedir(), ".claude", ".credentials.json");
  try {
    const raw = await readFile(credPath, "utf-8");
    return parseClaudeCredentialJson(raw);
  } catch {
    return null;
  }
}

/**
 * Bearer token を使って api.anthropic.com へ軽量 probe を行い、
 * レスポンスヘッダーの `anthropic-organization-id` を返す。
 * 取得できない場合は null。
 */
async function probeOrganizationId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(8000),
    });
    return res.headers.get("anthropic-organization-id") ?? null;
  } catch {
    return null;
  }
}

// T323: formatUtil / formatReset / formatSelectable は token-format.ts に移管

// ─────────────────────────────────────────────────────────────────────────────
// token add 引数解析（T391）
// ─────────────────────────────────────────────────────────────────────────────

interface SubscriptionAddArgs {
  /** `--subscription <handle>` で渡される handle（例 `@tayo`）。`@` 抜きで渡された場合は補正する */
  handle: string;
  plan: TokenPlan;
  planRatio: number | null;
  tags: string[];
  organizationId: string | null;
}

/**
 * `cmux-team token add ...` の追加引数（T391）から subscription mode かを判定し
 * 必要なら引数を返す。
 *
 * - `--from-claude-credentials` flag が含まれる場合は v4.20.0 で削除済みエラーで exit 1
 * - `--subscription <handle>` 形式なら subscription mode で `SubscriptionAddArgs` を返す
 * - それ以外は null を返す（呼び出し側は対話 UI へフォールバック）
 *
 * tokens 引数は `cmux-team token add` 以降（`process.argv.slice(4)`）を想定。
 */
function parseTokenAddArgs(argv: string[]): SubscriptionAddArgs | null {
  // `--from-claude-credentials` は T391 で削除（後方互換なし）
  if (argv.includes("--from-claude-credentials")) {
    console.error(
      "Error: --from-claude-credentials は v4.20.0 で削除されました。Use --subscription <handle> instead.",
    );
    process.exit(1);
  }

  const subIdx = argv.indexOf("--subscription");
  if (subIdx === -1) return null;

  // --subscription の直後の引数を handle として扱う。flag-style の `--xxx` は弾く。
  const handleRaw = argv[subIdx + 1];
  if (!handleRaw || handleRaw.startsWith("--")) {
    console.error("Error: --subscription <handle> を指定してください（例: --subscription @tayo）");
    process.exit(1);
  }
  const handle = handleRaw.startsWith("@") ? handleRaw : `@${handleRaw}`;

  // --plan
  const planArg = readFlag(argv, "--plan");
  let plan: TokenPlan = "unknown";
  let planRatio: number | null = null;
  if (planArg) {
    const entry = PLAN_BY_NAME[planArg];
    if (!entry) {
      console.error(`Error: 不正な plan: ${planArg}（pro / max-x5 / max-x20 のいずれかを指定）`);
      process.exit(1);
    }
    plan = entry.plan;
    planRatio = entry.ratio;
  }

  // --tags（comma-separated）
  const tagsArg = readFlag(argv, "--tags");
  const tags = tagsArg
    ? tagsArg.split(",").map((t) => t.trim()).filter(Boolean)
    : ["any"];

  // --organization-id（任意）
  const organizationId = readFlag(argv, "--organization-id");

  return { handle, plan, planRatio, tags, organizationId };
}

/** `argv` から `--<name> <value>` 形式の値を取り出す（無ければ null）。 */
function readFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  const v = argv[idx + 1];
  if (!v || v.startsWith("--")) return null;
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// token add（T391: --subscription / --from-claude-credentials を処理）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `cmux-team token add` のエントリ。
 *
 * - `--subscription <handle>` flag があれば非対話で subscription source として登録（keychain 不参照）
 * - `--from-claude-credentials` は v4.20.0 で削除（exit 1）
 * - flag なしなら従来の対話 UI（manual のみ。`[1] claude-credentials` は T391 で削除）
 */
export async function cmdTokenAdd(): Promise<void> {
  const extraArgs = process.argv.slice(4);
  const subArgs = parseTokenAddArgs(extraArgs);
  if (subArgs) {
    await cmdTokenAddSubscription(subArgs);
    return;
  }

  // Keychain が必要な経路（manual）のみ macOS / KEYCHAIN_TEST_MODE をチェック
  if (process.platform !== "darwin" && process.env.KEYCHAIN_TEST_MODE !== "1") {
    console.error("Error: token pool は macOS Keychain が必要です（macOS 以外は未対応）");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // T391: 対話 UI の `[1] Claude Code credential` を削除し manual のみに簡略化。
    // subscription を対話で登録したい場合は `--subscription <handle>` flag を使う旨を案内する。
    console.log("source:");
    console.log("  [1] 手動入力（token を貼り付け）");
    console.log("");
    console.log("Note: Claude Max などの subscription token は");
    console.log("      `cmux-team token add --subscription <handle> [--plan max-x20] [--tags any]` を使ってください。");
    console.log("      （Claude Code 本体が認証管理するため keychain には保存しません）");
    const source = (await prompt(rl, "> ")).trim();

    if (source !== "1") {
      console.error("Error: 1 を選択してください（subscription は --subscription flag を使用）");
      process.exit(1);
    }

    const accessToken = (await prompt(rl, "token を貼り付け: ")).trim();
    if (!accessToken) {
      console.error("Error: token が空です");
      process.exit(1);
    }
    const rateLimitTier: string | undefined = undefined;

    // organization_id を probe
    process.stdout.write("organization_id を取得中...");
    const organizationId = await probeOrganizationId(accessToken);
    process.stdout.write("\r");

    if (!organizationId) {
      console.error("Error: organization_id を取得できませんでした（token が無効または期限切れの可能性があります）");
      process.exit(1);
    }

    console.log(`\nFound credential:`);
    console.log(`  organizationId: ${organizationId}`);
    // T349: rateLimitTier 由来で plan が解決できない場合は helper 内で対話 prompt
    const { plan, planRatio } = await resolvePlanForRegistration(rl, rateLimitTier);

    // handle
    const handleRaw = (await prompt(rl, "\ndisplay name (例: personal, kddi-dev): ")).trim();
    if (!handleRaw) {
      console.error("Error: display name は必須です");
      process.exit(1);
    }
    // handle は先頭 4 文字（小文字英数）→ @xxxx 形式
    const handleSlug = handleRaw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
    if (!handleSlug) {
      console.error("Error: handle に使える英数字が含まれていません");
      process.exit(1);
    }
    const handle = `@${handleSlug}`;

    // tags
    const tagsRaw = (await prompt(rl, "tags (comma-separated, 例: any / oss-only / org:kddi): ")).trim();
    const tags = tagsRaw
      ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : ["any"];

    // DB に登録
    const db = initTokenDB();
    const authHash = computeAuthHash(accessToken);

    // 既存チェック
    const existingByOrg = db.prepare("SELECT handle FROM tokens WHERE organization_id = ?").get(organizationId) as { handle: string } | undefined;
    if (existingByOrg) {
      console.error(`Error: organization_id が既に ${existingByOrg.handle} として登録されています。rotate コマンドを使ってください。`);
      process.exit(1);
    }
    const existingByHandle = db.prepare("SELECT id FROM tokens WHERE handle = ?").get(handle) as { id: number } | undefined;
    if (existingByHandle) {
      console.error(`Error: handle ${handle} は既に使用されています。別の名前を指定してください。`);
      process.exit(1);
    }

    // Keychain に保存
    storeTokenInKeychain(handle, accessToken);

    insertToken(db, {
      handle,
      organization_id: organizationId,
      auth_hash: authHash,
      plan,
      plan_ratio: planRatio,
      tags,
      credential_source: "manual",
      selectable: true,
    });
    db.close();

    console.log(`\nRegistered: ${handle}  ${plan}  tags:[${tags.join(", ")}]  ✓`);
  } finally {
    rl.close();
  }
}

/**
 * `cmux-team token add --subscription <handle> [--plan ...] [--tags ...] [--organization-id ...]`（T391）。
 *
 * - keychain には書き込まない（Claude Code 本体が `~/.claude/.credentials.json` で管理）
 * - `auth_hash` / `organization_id` は省略可。proxy が初観測時に UPDATE する
 * - 既存 handle と衝突したら exit 1
 */
async function cmdTokenAddSubscription(args: SubscriptionAddArgs): Promise<void> {
  const db = initTokenDB();
  try {
    const existing = getTokenByHandle(db, args.handle);
    if (existing) {
      console.error(`Error: handle ${args.handle} は既に使用されています。別の名前を指定してください。`);
      process.exit(1);
    }
    if (args.organizationId) {
      const dup = db
        .prepare("SELECT handle FROM tokens WHERE organization_id = ?")
        .get(args.organizationId) as { handle: string } | undefined;
      if (dup) {
        console.error(`Error: organization_id が既に ${dup.handle} として登録されています。`);
        process.exit(1);
      }
    }

    insertToken(db, {
      handle: args.handle,
      organization_id: args.organizationId,
      auth_hash: null,
      plan: args.plan,
      plan_ratio: args.planRatio,
      tags: args.tags,
      credential_source: "subscription",
      selectable: true,
    });
    console.log(
      `Registered subscription: ${args.handle}  ${args.plan}  tags:[${args.tags.join(", ")}]  ✓`,
    );
    console.log("Note: keychain には保存しません（Claude Code 本体が認証管理）");
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// token list
// ─────────────────────────────────────────────────────────────────────────────

/** T391: credential_source を list 表示用ラベルに整形する。 */
function formatCredLabel(source: CredentialSource | null): string {
  switch (source) {
    case "manual":
      return "manual";
    case "subscription":
      return "oauth-native";
    case "auto-discover":
      return "auto";
    default:
      return "-";
  }
}

export async function cmdTokenList(): Promise<void> {
  const db = initTokenDB();
  const tokens = listTokens(db);

  if (tokens.length === 0) {
    console.log("登録済みトークンがありません。`cmux-team token add` で追加してください。");
    db.close();
    return;
  }

  // T390: 行末に独立した MARK 列を置き、reset 通過済み stale token を視認できるようにする
  const header = [
    "HANDLE  ",
    "PLAN    ",
    "CRED        ",
    "TAGS      ",
    "SELECTABLE",
    "CAP   ",
    "UTIL_5H",
    "UTIL_7D",
    "NEXT_RESET    ",
    "MARK",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  // T390: marker 凡例を出すかの判定用。ループ内で 1 つでも marker が出れば true。
  const nowMs = Date.now();
  let anyMarker = false;

  for (const tok of tokens) {
    const snap = getLatestUsageSnapshot(db, tok.id);
    const selectable = formatSelectable(tok, snap);

    // CAP は pool_capacity の per-token cap_pct（util があれば計算）
    let capStr = "--";
    if (tok.plan_ratio != null && snap) {
      const { computePoolCapacity } = await import("./token-store");
      const { per_token } = computePoolCapacity([
        {
          handle: tok.handle,
          plan_ratio: tok.plan_ratio,
          util_5h: snap.util_5h,
          util_7d: snap.util_7d,
          reset_5h_at: snap.reset_5h_at,
          reset_7d_at: snap.reset_7d_at,
        },
      ]);
      const capPct = per_token[0]?.cap_pct;
      if (capPct != null) capStr = `${Math.round(capPct)}%`;
    }

    // NEXT_RESET: 5h と 7d の近い方
    const resetCandidates: string[] = [];
    if (snap?.reset_5h_at) resetCandidates.push(`5h@${formatReset(snap.reset_5h_at)}`);
    if (snap?.reset_7d_at) resetCandidates.push(`7d@${formatReset(snap.reset_7d_at)}`);
    const nextReset = resetCandidates[0] ?? "--";

    // T390: per-handle 行は effUtil 表示。reset 通過済み stale token は MARK 列に "*"。
    const fmt = formatPerHandleUtilCell(snap, nowMs);
    if (fmt.marker !== "") anyMarker = true;

    const row = [
      tok.handle.padEnd(8),
      tok.plan.padEnd(8),
      formatCredLabel(tok.credential_source).padEnd(12),
      tok.tags.join(",").slice(0, 10).padEnd(10),
      selectable.padEnd(10),
      capStr.padEnd(6),
      fmt.display5h.padEnd(7),
      fmt.display7d.padEnd(7),
      nextReset.padEnd(14),
      fmt.marker,
    ].join("  ");
    console.log(row);
  }

  if (anyMarker) {
    console.log("(* = reset 通過済みで実質クリア)");
  }

  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// token migrate-subscription (T391)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `cmux-team token migrate-subscription`（T391）。
 *
 * 旧 `claude-credentials` source は initTokenDB の起動時 migration で
 * 既に `subscription` + `auth_hash=NULL` に変換されている。本コマンドは
 * その row 群について cmux-team が過去に snapshot した keychain entry
 * （`security` service=`cmux-team-token`）を `delete-generic-password` で消す。
 *
 * - 冪等。entry が無ければ 44 (errSecItemNotFound) を成功扱いで握りつぶす
 * - subscription source の row 全件を対象とする（旧 claude-credentials 由来かは
 *   migration 後では判別できないため、subscription 全体を一律 cleanup する）
 */
export async function cmdTokenMigrateSubscription(): Promise<void> {
  const db = initTokenDB();
  try {
    const tokens = listTokens(db).filter((t) => t.credential_source === "subscription");
    if (tokens.length === 0) {
      console.log("subscription source の token はありません。");
      return;
    }
    let removed = 0;
    let skipped = 0;
    for (const tok of tokens) {
      try {
        deleteTokenFromKeychain(tok.handle);
        removed++;
        console.log(`  ${tok.handle}  keychain entry を削除（または不在）`);
      } catch (e: any) {
        if (e instanceof KeychainUnsupportedError) {
          // 非 macOS は skip（CI 等）
          skipped++;
          continue;
        }
        // 想定外エラーは warn で続行（冪等性を維持）
        console.warn(`  ${tok.handle}  Warning: ${e?.message ?? e}`);
        skipped++;
      }
    }
    console.log(`Done: removed=${removed}, skipped=${skipped}, total=${tokens.length}`);
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// token remove
// ─────────────────────────────────────────────────────────────────────────────

export async function cmdTokenRemove(): Promise<void> {
  const handle = getHandleArg();
  const db = initTokenDB();
  const tok = getTokenByHandle(db, handle);
  if (!tok) {
    console.error(`Error: ${handle} は登録されていません`);
    db.close();
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const confirm = (await prompt(rl, `${handle} を削除します。よろしいですか？ [y/N] `)).trim().toLowerCase();
    if (confirm !== "y") {
      console.log("キャンセルしました。");
      db.close();
      return;
    }
  } finally {
    rl.close();
  }

  // leases / usage_snapshots は CASCADE ではなく手動削除
  db.prepare("DELETE FROM usage_snapshots WHERE token_id = ?").run(tok.id);
  db.prepare("DELETE FROM leases WHERE token_id = ?").run(tok.id);
  db.prepare("DELETE FROM tokens WHERE id = ?").run(tok.id);
  db.close();

  try {
    deleteTokenFromKeychain(handle);
  } catch (e: any) {
    if (!(e instanceof KeychainUnsupportedError)) {
      console.warn(`Warning: Keychain 削除に失敗しました: ${e?.message ?? e}`);
    }
  }

  console.log(`${handle} を削除しました。`);
}

// ─────────────────────────────────────────────────────────────────────────────
// token rotate
// ─────────────────────────────────────────────────────────────────────────────

export async function cmdTokenRotate(): Promise<void> {
  const handle = getHandleArg();
  const db = initTokenDB();
  const tok = getTokenByHandle(db, handle);
  if (!tok) {
    console.error(`Error: ${handle} は登録されていません`);
    db.close();
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let newToken: string;

  try {
    console.log(`新しい token を貼り付け（または [1] credential から再取得 (macOS Keychain / ファイル)）:`);
    const input = (await prompt(rl, "> ")).trim();

    if (input === "1") {
      const cred = await readClaudeCredentials();
      if (!cred) {
        console.error("Error: Claude Code credential が見つかりません（macOS Keychain / ~/.claude/.credentials.json のどちらも読めませんでした）");
        process.exit(1);
      }
      newToken = cred.accessToken;
    } else {
      newToken = input;
    }
  } finally {
    rl.close();
  }

  if (!newToken) {
    console.error("Error: token が空です");
    db.close();
    process.exit(1);
  }

  const newAuthHash = computeAuthHash(newToken);

  // Keychain 更新（storeTokenInKeychain は -U フラグで上書き）
  storeTokenInKeychain(handle, newToken);

  // DB 更新（auth_hash のみ）
  db.prepare("UPDATE tokens SET auth_hash = ? WHERE id = ?").run(newAuthHash, tok.id);
  db.close();

  console.log(`Keychain の token を更新し、auth_hash を更新しました。  ✓`);
}

// ─────────────────────────────────────────────────────────────────────────────
// token set-plan
// ─────────────────────────────────────────────────────────────────────────────

export async function cmdTokenSetPlan(): Promise<void> {
  const handle = getHandleArg();
  const planArg = process.argv[5]; // cmux-team token set-plan @handle <plan>
  if (!planArg) {
    console.error("Usage: cmux-team token set-plan @handle <plan>");
    console.error("  plan: pro | max-x5 | max-x20");
    process.exit(1);
  }

  const validPlans: Record<string, number> = {
    pro: 1.0,
    "max-x5": 5.0,
    "max-x20": 20.0,
  };
  const ratio = validPlans[planArg];
  if (ratio == null) {
    console.error(`Error: 不正な plan: ${planArg}（pro / max-x5 / max-x20 のいずれかを指定）`);
    process.exit(1);
  }

  const db = initTokenDB();
  const tok = getTokenByHandle(db, handle);
  if (!tok) {
    console.error(`Error: ${handle} は登録されていません`);
    db.close();
    process.exit(1);
  }

  db.prepare("UPDATE tokens SET plan = ?, plan_ratio = ? WHERE id = ?").run(planArg, ratio, tok.id);
  db.close();

  console.log(`${handle} の plan を ${planArg} (ratio ${ratio.toFixed(1)}) に設定しました。`);
}

// ─────────────────────────────────────────────────────────────────────────────
// token promote (T341)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * auto-discover 経由で登録された token を正規 handle に昇格させる migration コマンド。
 *
 * - source 選択 UI は `cmdTokenAdd` と同形（claude credential / 手動入力）
 * - probe で取れた `organization_id` が DB の既存値と一致することを検証する
 * - Keychain 先 → DB 後の順で更新（既存 add と同じ順序）
 * - 旧 token_id を維持するため `usage_snapshots` は壊れない
 */
export async function cmdTokenPromote(): Promise<void> {
  const oldHandle = getHandleArg();
  const newDisplayName = process.argv[5];
  if (!newDisplayName) {
    console.error("Usage: cmux-team token promote @<auto-handle> <new-display-name>");
    process.exit(1);
  }

  if (process.platform !== "darwin" && process.env.KEYCHAIN_TEST_MODE !== "1") {
    console.error("Error: token pool は macOS Keychain が必要です（macOS 以外は未対応）");
    process.exit(1);
  }

  const db = initTokenDB();
  try {
    const existing = getTokenByHandle(db, oldHandle);
    if (!existing) {
      console.error(`Error: ${oldHandle} は登録されていません`);
      process.exit(1);
    }
    if (existing.credential_source !== "auto-discover") {
      console.error(
        `Error: ${oldHandle} は auto-discover で登録された token ではありません`
        + ` (credential_source=${existing.credential_source})。`
        + ` promote は auto-discover token の正規昇格専用です。`,
      );
      process.exit(1);
    }

    // 新 handle 採番（cmdTokenAdd と同じロジック: 小文字英数 4 文字 → @xxxx）
    const slug = newDisplayName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
    if (!slug) {
      console.error("Error: display name に使える英数字が含まれていません");
      process.exit(1);
    }
    const newHandle = `@${slug}`;
    if (newHandle !== oldHandle) {
      const collision = getTokenByHandle(db, newHandle);
      if (collision) {
        console.error(`Error: handle ${newHandle} は既に使用されています`);
        process.exit(1);
      }
    } else {
      console.log(
        `情報: handle は変わりません（display name=${newDisplayName} → ${newHandle}）。`
        + ` credential / plan / tags のみ更新します。`,
      );
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let accessToken: string;
    let rateLimitTier: string | undefined;
    // T391: promote の credential_source は manual のみに統一する。
    // subscription source は keychain を持たないため probe → keychain 保存の
    // promote フローと相容れない。subscription を新規追加する場合は
    // `cmux-team token add --subscription <handle>` を使う。
    const credentialSource: CredentialSource = "manual";
    let tags: string[];
    let plan: TokenPlan;
    let planRatio: number | null;
    try {
      console.log("source:");
      console.log("  [1] Claude Code credential (macOS Keychain / ~/.claude/.credentials.json) — manual として保存");
      console.log("  [2] 手動入力（token を貼り付け）");
      const source = (await prompt(rl, "> ")).trim();
      if (source === "1") {
        const cred = await readClaudeCredentials();
        if (!cred) {
          console.error("Error: Claude Code credential が見つかりません（macOS Keychain / ~/.claude/.credentials.json のどちらも読めませんでした）");
          process.exit(1);
        }
        accessToken = cred.accessToken;
        rateLimitTier = cred.rateLimitTier;
      } else if (source === "2") {
        accessToken = (await prompt(rl, "token を貼り付け: ")).trim();
        if (!accessToken) {
          console.error("Error: token が空です");
          process.exit(1);
        }
        rateLimitTier = undefined;
      } else {
        console.error("Error: 1 または 2 を選択してください");
        process.exit(1);
      }

      process.stdout.write("organization_id を取得中...");
      const probedOrgId = await probeOrganizationId(accessToken);
      process.stdout.write("\r");
      if (!probedOrgId) {
        console.error("Error: organization_id を取得できませんでした（token が無効または期限切れの可能性があります）");
        process.exit(1);
      }
      if (probedOrgId !== existing.organization_id) {
        const existingLabel = existing.organization_id ? `${existing.organization_id.slice(0, 8)}...` : "(null)";
        console.error(
          `Error: 取得した token は ${oldHandle} とは別アカウントです`
          + ` (existing=${existingLabel} probed=${probedOrgId.slice(0, 8)}...)`,
        );
        process.exit(1);
      }

      console.log(`\nFound credential:`);
      console.log(`  organizationId: ${probedOrgId}`);
      // T349: rateLimitTier 由来で plan が解決できない場合は helper 内で対話 prompt
      ({ plan, planRatio } = await resolvePlanForRegistration(rl, rateLimitTier));

      const tagsRaw = (await prompt(rl, "tags (comma-separated, default: any): ")).trim();
      tags = tagsRaw
        ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
        : ["any"];
    } finally {
      rl.close();
    }

    const newAuthHash = computeAuthHash(accessToken);

    // Keychain 先 → DB 後の順序（cmdTokenAdd と同じ）
    storeTokenInKeychain(newHandle, accessToken);
    updateTokenPromoteFields(db, existing.id, {
      handle: newHandle,
      auth_hash: newAuthHash,
      plan,
      plan_ratio: planRatio,
      tags,
      credential_source: credentialSource,
    });

    console.log(
      `\nPromoted: ${oldHandle} → ${newHandle}  ${plan}  tags:[${tags.join(", ")}]  ✓`,
    );
    if (plan === "unknown") {
      console.log(
        `Hint: plan が unknown です。capacity 計算を有効にするには`
        + ` \`cmux-team token set-plan ${newHandle} <pro|max-x5|max-x20>\` で訂正してください。`,
      );
    }
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部ヘルパ
// ─────────────────────────────────────────────────────────────────────────────

function getHandleArg(): string {
  // cmux-team token remove @handle → process.argv[4]
  const raw = process.argv[4];
  if (!raw) {
    console.error("Error: handle を指定してください（例: @pers）");
    process.exit(1);
  }
  return raw.startsWith("@") ? raw : `@${raw}`;
}

import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
  paginate,
  type InlineButton,
} from "../toolkit/index.js";
import { getStore } from "../store.js";
import type { HistoryEntry, Team } from "../types.js";

registerMainMenuItem({ label: "📋 History", data: "history:menu", order: 30 });

const composer = new Composer<Ctx>();

const PER_PAGE = 5;

async function loadTeam(id: string): Promise<Team | null> {
  const store = getStore();
  const raw = await store.get(`team:${id}`);
  if (!raw) return null;
  return JSON.parse(raw) as Team;
}

async function loadHistoryEntries(): Promise<HistoryEntry[]> {
  const store = getStore();
  const keys = await store.keys("history:*");
  const entries: HistoryEntry[] = [];
  for (const k of keys) {
    const raw = await store.get(k);
    if (!raw) continue;
    entries.push(JSON.parse(raw) as HistoryEntry);
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.sessionId.localeCompare(a.sessionId));
  return entries;
}

async function loadDigest(sessionId: string): Promise<Record<string, unknown> | null> {
  const store = getStore();
  const keys = await store.keys("digest:*");
  for (const k of keys) {
    const raw = await store.get(k);
    if (!raw) continue;
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d.sessionId === sessionId) return d;
  }
  return null;
}

composer.callbackQuery("history:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const entries = await loadHistoryEntries();
  await showHistoryPage(ctx, entries, 0);
});

composer.callbackQuery(/^history:page:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1], 10);
  const entries = await loadHistoryEntries();
  await showHistoryPage(ctx, entries, page);
});

composer.callbackQuery(/^history:prev:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1], 10);
  const entries = await loadHistoryEntries();
  await showHistoryPage(ctx, entries, page);
});

composer.callbackQuery(/^history:next:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1], 10);
  const entries = await loadHistoryEntries();
  await showHistoryPage(ctx, entries, page);
});

async function showHistoryPage(ctx: Ctx, entries: HistoryEntry[], pageNum: number) {
  const filtered = entries;
  const paginated = paginate(filtered, {
    page: pageNum,
    perPage: PER_PAGE,
    callbackPrefix: "history",
  });

  if (paginated.pageItems.length === 0) {
    await ctx.editMessageText(
      "No standup history yet. Run a standup from the 📊 Standup menu to get started.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const lines: string[] = [`Standup history — page ${paginated.page + 1} of ${paginated.totalPages}`];
  lines.push("");

  for (const entry of paginated.pageItems) {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const date = new Date(entry.date + "T00:00:00Z");
    const dayName = dayNames[date.getUTCDay()];

    lines.push(`${dayName} ${entry.date}`);
    lines.push(`  Team: ${entry.teamName}`);
    lines.push(`  Responses: ${entry.responseCount}/${entry.memberCount}${entry.blockerCount > 0 ? "  ⚠️" + entry.blockerCount + " blockers" : ""}`);
    lines.push(`  [View](https://t.me/standup_bot?history=${entry.sessionId})`);
    lines.push("");
  }

  const text = lines.join("\n");

  const rows: ReturnType<typeof inlineButton>[][] = paginated.pageItems.map((e) => [
    inlineButton(`${e.date} — ${e.teamName}`, `history:detail:${e.sessionId}`),
  ]);

  const keyboardRows: InlineButton[][] = [...rows];
  if (paginated.controls.inline_keyboard.length > 0) {
    keyboardRows.push(...paginated.controls.inline_keyboard);
  }
  keyboardRows.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(keyboardRows),
  });
}

composer.callbackQuery(/^history:detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match[1];
  const digest = await loadDigest(sessionId);

  if (!digest) {
    await ctx.answerCallbackQuery({ text: "Session details not available.", show_alert: true });
    return;
  }

  const memberAnswers = (digest.memberAnswers as Array<{ memberName: string; answers: string[] }>) ?? [];
  const blockerHighlights = (digest.blockerHighlights as string[]) ?? [];
  const pendingNames = (digest.pendingMemberNames as string[]) ?? [];
  const date = (digest.date as string) ?? "unknown";

  const lines: string[] = [`📋 Standup ${date}`];
  lines.push("");

  for (const ma of memberAnswers) {
    lines.push(`👤 ${ma.memberName}`);
    for (let i = 0; i < ma.answers.length; i++) {
      lines.push(`  ${i + 1}. ${ma.answers[i]}`);
    }
    lines.push("");
  }

  if (pendingNames.length > 0) {
    lines.push(`⏳ Did not respond: ${pendingNames.join(", ")}`);
    lines.push("");
  }

  if (blockerHighlights.length > 0) {
    lines.push("⚠️ Blockers:");
    for (const b of blockerHighlights) {
      lines.push(`  • ${b}`);
    }
  }

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to history", "history:page:0")],
      [inlineButton("⬅️ Main Menu", "menu:main")],
    ]),
  });
});

export default composer;
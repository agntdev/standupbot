import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  urlButton,
  inlineKeyboard,
  paginate,
  type InlineButton,
} from "../toolkit/index.js";
import { getStore } from "../store.js";
import type { HistoryEntry, Team, Digest } from "../types.js";

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

async function loadDigest(sessionId: string): Promise<Digest | null> {
  const store = getStore();
  const keys = await store.keys("digest:*");
  for (const k of keys) {
    const raw = await store.get(k);
    if (!raw) continue;
    const d = JSON.parse(raw) as Digest;
    if (d.sessionId === sessionId) return d;
  }
  return null;
}

function filterEntries(
  entries: HistoryEntry[],
  filters: { keyword?: string; memberName?: string; dateFrom?: string; dateTo?: string; teamId?: string },
): HistoryEntry[] {
  return entries.filter((e) => {
    if (filters.teamId && e.teamId !== filters.teamId) return false;
    if (filters.dateFrom && e.date < filters.dateFrom) return false;
    if (filters.dateTo && e.date > filters.dateTo) return false;
    if (filters.keyword) {
      const kw = filters.keyword.toLowerCase();
      const teamMatch = e.teamName.toLowerCase().includes(kw);
      const textMatch = (e.allText ?? "").toLowerCase().includes(kw);
      if (!teamMatch && !textMatch) return false;
    }
    if (filters.memberName) {
      const mn = filters.memberName.toLowerCase();
      const hasMatch = (e.memberNames ?? []).some((n) => n.toLowerCase().includes(mn));
      if (!hasMatch) return false;
    }
    return true;
  });
}

function channelPermalink(entry: HistoryEntry): string | null {
  if (entry.channelId && entry.channelMessageId) {
    const rawId = String(entry.channelId).replace(/^-100/, "");
    return `https://t.me/c/${rawId}/${entry.channelMessageId}`;
  }
  return null;
}

composer.command("history", async (ctx) => {
  ctx.session.searchingHistory = {};
  ctx.session.step = "history_search_keyword";
  await ctx.reply(
    "Search past standups. Send a keyword to filter by team name, or tap Skip to see all.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏭️ Skip", "history:filter:skip")],
        [inlineButton("❌ Cancel", "menu:main")],
      ]),
    },
  );
});

composer.callbackQuery("history:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const entries = await loadHistoryEntries();
  await showHistoryPage(ctx, entries, {}, 0);
});

composer.callbackQuery("history:filter", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.searchingHistory = {};
  ctx.session.step = "history_search_keyword";
  await ctx.editMessageText(
    "Search past standups. Send a keyword to filter by team name, or tap Skip.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏭️ Skip", "history:filter:skip")],
        [inlineButton("❌ Cancel", "history:menu")],
      ]),
    },
  );
});

composer.callbackQuery("history:filter:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.searchingHistory) ctx.session.searchingHistory = {};
  ctx.session.step = "history_search_member_name";
  await ctx.editMessageText(
    "Filter by member name? Send a name to search for, or tap Skip.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏭️ Skip", "history:filter:member:skip")],
        [inlineButton("❌ Cancel", "history:menu")],
      ]),
    },
  );
});

composer.callbackQuery("history:filter:member:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.searchingHistory) ctx.session.searchingHistory = {};
  ctx.session.step = "history_search_date_from";
  await ctx.editMessageText(
    "Filter by start date? Send a date (YYYY-MM-DD) or tap Skip.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏭️ Skip", "history:filter:date:skip")],
        [inlineButton("❌ Cancel", "history:menu")],
      ]),
    },
  );
});

composer.callbackQuery("history:filter:date:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.searchingHistory) ctx.session.searchingHistory = {};
  ctx.session.step = "history_search_date_to";
  await ctx.editMessageText(
    "Filter by end date? Send a date (YYYY-MM-DD) or tap Skip.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏭️ Skip", "history:filter:date:end:skip")],
        [inlineButton("❌ Cancel", "history:menu")],
      ]),
    },
  );
});

composer.callbackQuery("history:filter:date:end:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.searchingHistory) ctx.session.searchingHistory = {};
  ctx.session.step = undefined;
  const filters = ctx.session.searchingHistory;
  const entries = await loadHistoryEntries();
  const filtered = filterEntries(entries, filters);
  await showHistoryPage(ctx, filtered, filters, 0);
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;

  if (step === "history_search_keyword") {
    if (!ctx.session.searchingHistory) ctx.session.searchingHistory = {};
    const kw = ctx.message.text.trim();
    if (kw) {
      ctx.session.searchingHistory.keyword = kw;
    }
    ctx.session.step = "history_search_member_name";
    await ctx.reply(
      "Filter by member name? Send a name to search for, or tap Skip.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⏭️ Skip", "history:filter:member:skip")],
          [inlineButton("❌ Cancel", "history:menu")],
        ]),
      },
    );
    return;
  }

  if (step === "history_search_member_name") {
    if (!ctx.session.searchingHistory) ctx.session.searchingHistory = {};
    const name = ctx.message.text.trim();
    if (name) {
      ctx.session.searchingHistory.memberName = name;
    }
    ctx.session.step = "history_search_date_from";
    await ctx.reply(
      "Filter by start date? Send a date (YYYY-MM-DD) or tap Skip.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⏭️ Skip", "history:filter:date:skip")],
          [inlineButton("❌ Cancel", "history:menu")],
        ]),
      },
    );
    return;
  }

  if (step === "history_search_date_from") {
    if (!ctx.session.searchingHistory) ctx.session.searchingHistory = {};
    const text = ctx.message.text.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      ctx.session.searchingHistory.dateFrom = text;
    }
    ctx.session.step = "history_search_date_to";
    await ctx.reply(
      "Filter by end date? Send a date (YYYY-MM-DD) or tap Skip.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⏭️ Skip", "history:filter:date:end:skip")],
          [inlineButton("❌ Cancel", "history:menu")],
        ]),
      },
    );
    return;
  }

  if (step === "history_search_date_to") {
    if (!ctx.session.searchingHistory) ctx.session.searchingHistory = {};
    const text = ctx.message.text.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      ctx.session.searchingHistory.dateTo = text;
    }
    ctx.session.step = undefined;
    const filters = ctx.session.searchingHistory;
    const entries = await loadHistoryEntries();
    const filtered = filterEntries(entries, filters);
    await showHistoryPage(ctx, filtered, filters, 0);
    return;
  }

  return next();
});

composer.callbackQuery(/^history:page:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1], 10);
  const entries = await loadHistoryEntries();
  const filters = ctx.session.searchingHistory ?? {};
  const filtered = filterEntries(entries, filters);
  await showHistoryPage(ctx, filtered, filters, page);
});

composer.callbackQuery(/^history:prev:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1], 10);
  const entries = await loadHistoryEntries();
  const filters = ctx.session.searchingHistory ?? {};
  const filtered = filterEntries(entries, filters);
  await showHistoryPage(ctx, filtered, filters, page);
});

composer.callbackQuery(/^history:next:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1], 10);
  const entries = await loadHistoryEntries();
  const filters = ctx.session.searchingHistory ?? {};
  const filtered = filterEntries(entries, filters);
  await showHistoryPage(ctx, filtered, filters, page);
});

async function showHistoryPage(
  ctx: Ctx,
  entries: HistoryEntry[],
  filters: { keyword?: string; memberName?: string; dateFrom?: string; dateTo?: string },
  pageNum: number,
) {
  const paginated = paginate(entries, {
    page: pageNum,
    perPage: PER_PAGE,
    callbackPrefix: "history",
  });

  if (paginated.pageItems.length === 0) {
    const hasFilters = filters.keyword || filters.dateFrom || filters.dateTo;
    await ctx.editMessageText(
      hasFilters
        ? "No standups match your filters. Try different criteria."
        : "No standup history yet. Run a standup from the 📊 Standup menu to get started.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🔍 New Search", "history:filter")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const filterParts: string[] = [];
  if (filters.keyword) filterParts.push(`keyword: ${filters.keyword}`);
  if (filters.memberName) filterParts.push(`member: ${filters.memberName}`);
  if (filters.dateFrom || filters.dateTo) {
    filterParts.push(`dates: ${filters.dateFrom ?? "any"} → ${filters.dateTo ?? "any"}`);
  }
  const filterLabel = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";

  const lines: string[] = [`Standup history${filterLabel} — page ${paginated.page + 1} of ${paginated.totalPages}`];
  lines.push("");

  for (const entry of paginated.pageItems) {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const date = new Date(entry.date + "T00:00:00Z");
    const dayName = dayNames[date.getUTCDay()];

    const permalink = channelPermalink(entry);

    lines.push(`${dayName} ${entry.date}`);
    lines.push(`  Team: ${entry.teamName}`);
    lines.push(`  Responses: ${entry.responseCount}/${entry.memberCount}${entry.blockerCount > 0 ? "  ⚠️" + entry.blockerCount + " blockers" : ""}`);
    if (permalink) {
      lines.push(`  [View in channel](${permalink})`);
    }
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
  keyboardRows.push([inlineButton("🔍 Search", "history:filter")]);
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

  const historyEntry = await (async () => {
    const store = getStore();
    const raw = await store.get(`history:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as HistoryEntry;
  })();

  const memberAnswers = digest.memberAnswers ?? [];
  const blockerHighlights = digest.blockerHighlights ?? [];
  const pendingNames = digest.pendingMemberNames ?? [];
  const date = digest.date ?? "unknown";

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

  const permalink = historyEntry ? channelPermalink(historyEntry) : null;
  const keyboardRows: InlineButton[][] = [];
  if (permalink) {
    keyboardRows.push([urlButton("🔗 Open in channel", permalink)]);
  }
  keyboardRows.push([inlineButton("⬅️ Back to history", "history:page:0")]);
  keyboardRows.push([inlineButton("⬅️ Main Menu", "menu:main")]);

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard(keyboardRows),
  });
});

export default composer;
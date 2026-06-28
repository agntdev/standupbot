import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getStore } from "../store.js";
import type { Team, StandupSession, StandupResponse, Digest, HistoryEntry, Member } from "../types.js";

registerMainMenuItem({ label: "📊 Standup", data: "standup:menu", order: 20 });

const composer = new Composer<Ctx>();

async function loadTeam(id: string): Promise<Team | null> {
  const store = getStore();
  const raw = await store.get(`team:${id}`);
  if (!raw) return null;
  return JSON.parse(raw) as Team;
}

async function loadSession(id: string): Promise<StandupSession | null> {
  const store = getStore();
  const raw = await store.get(`session:${id}`);
  if (!raw) return null;
  return JSON.parse(raw) as StandupSession;
}

async function saveSession(s: StandupSession): Promise<void> {
  const store = getStore();
  await store.set(`session:${s.id}`, JSON.stringify(s));
}

async function saveDigest(d: Digest): Promise<void> {
  const store = getStore();
  await store.set(`digest:${d.id}`, JSON.stringify(d));
}

async function saveHistoryEntry(e: HistoryEntry): Promise<void> {
  const store = getStore();
  await store.set(`history:${e.sessionId}`, JSON.stringify(e));
}

async function listTeamsForOwner(ownerId: number): Promise<Team[]> {
  const store = getStore();
  const keys = await store.keys("team:*");
  const teams: Team[] = [];
  for (const k of keys) {
    const raw = await store.get(k);
    if (!raw) continue;
    const t = JSON.parse(raw) as Team;
    if (t.ownerId === ownerId) teams.push(t);
  }
  return teams;
}

async function setActiveStandup(teamId: string, sessionId: string): Promise<void> {
  const store = getStore();
  await store.set(`active_standup:${teamId}`, sessionId);
}

async function getActiveStandup(teamId: string): Promise<string | null> {
  const store = getStore();
  return store.get(`active_standup:${teamId}`);
}

async function clearActiveStandup(teamId: string): Promise<void> {
  const store = getStore();
  await store.del(`active_standup:${teamId}`);
}

async function getMemberName(userId: number): Promise<string> {
  const store = getStore();
  const raw = await store.get(`member:${userId}`);
  if (raw) {
    const m = JSON.parse(raw) as Member;
    return m.displayName || `ID ${userId}`;
  }
  return `ID ${userId}`;
}

function backToStandupMenu() {
  return inlineKeyboard([
    [inlineButton("📊 Run Standup", "standup:pickteam")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

composer.callbackQuery("standup:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("📊 Standup — pick an action:", {
    reply_markup: backToStandupMenu(),
  });
});

composer.callbackQuery("standup:pickteam", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teams = await listTeamsForOwner(userId);

  if (teams.length === 0) {
    await ctx.editMessageText(
      "No teams yet. Create a team first with 🔧 Teams.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🔧 Create Team", "team:create")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const rows = teams.map((t) => [
    inlineButton(t.name, `standup:start:${t.id}`),
  ]);

  await ctx.editMessageText("Select a team to run the standup for:", {
    reply_markup: inlineKeyboard([
      ...rows,
      [inlineButton("⬅️ Back", "standup:menu")],
    ]),
  });
});

composer.callbackQuery(/^standup:start:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.match[1];
  const team = await loadTeam(teamId);

  if (!team) {
    await ctx.editMessageText("Team not found.");
    return;
  }

  if (team.ownerId !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: "Only the team owner can start a standup.", show_alert: true });
    return;
  }

  if (team.memberIds.length === 0) {
    await ctx.editMessageText(
      `Team "${team.name}" has no members. Add members first.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("➕ Add Members", `team:addmembers:${team.id}`)],
          [inlineButton("⬅️ Back", "standup:menu")],
        ]),
      },
    );
    return;
  }

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const scheduledTime = now.toISOString();
  const cutoff = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const session: StandupSession = {
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    teamId: team.id,
    date: dateStr,
    scheduledTime,
    cutoffTime: cutoff.toISOString(),
    questions: team.questions,
    responses: [],
    nudgedMemberIds: [],
    status: "active",
  };

  await saveSession(session);
  await setActiveStandup(team.id, session.id);

  const questionText = session.questions
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  let sentCount = 0;
  const failures: number[] = [];

  for (const memberId of team.memberIds) {
    try {
      await ctx.api.sendMessage(
        memberId,
        `☀️ Standup time for "${team.name}"!\n\n` +
          questionText +
          `\n\nReply with your answers (one per line). Cutoff is approximately 2 hours from now.`,
      );
      sentCount++;
    } catch {
      failures.push(memberId);
    }
  }

  let resultText =
    `📊 Standup started for "${team.name}".\n\n` +
    `Sent to ${sentCount}/${team.memberIds.length} members.`;

  if (failures.length > 0) {
    resultText += `\n\nCould not reach: ${failures.join(", ")} (they may need to DM the bot first).`;
  }

  resultText += `\n\nUse the buttons below to manage the standup.`;

  await ctx.editMessageText(resultText, {
    reply_markup: inlineKeyboard([
      [inlineButton("🔔 Nudge Pending", `standup:nudge:${session.id}`)],
      [inlineButton("✅ Complete Standup", `standup:complete:${session.id}`)],
      [inlineButton("⬅️ Standup Menu", "standup:menu")],
    ]),
  });
});

composer.callbackQuery(/^standup:nudge:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match[1];
  const session = await loadSession(sessionId);

  if (!session) {
    await ctx.editMessageText("Session not found.");
    return;
  }

  if (session.status !== "active") {
    await ctx.answerCallbackQuery({ text: "This standup is already complete.", show_alert: true });
    return;
  }

  const team = await loadTeam(session.teamId);
  if (!team) {
    await ctx.editMessageText("Team not found.");
    return;
  }

  const respondedIds = new Set(session.responses.map((r) => r.memberId));
  const pendingIds = team.memberIds.filter(
    (m) => !respondedIds.has(m) && !session.nudgedMemberIds.includes(m),
  );

  if (pendingIds.length === 0) {
    await ctx.editMessageText(
      "All members have already responded or been nudged.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("✅ Complete Standup", `standup:complete:${session.id}`)],
          [inlineButton("⬅️ Standup Menu", "standup:menu")],
        ]),
      },
    );
    return;
  }

  let sentCount = 0;
  for (const memberId of pendingIds) {
    try {
      await ctx.api.sendMessage(
        memberId,
        `⏰ Reminder: please submit your standup for "${team.name}"!\n\n` +
          session.questions
            .map((q, i) => `${i + 1}. ${q}`)
            .join("\n"),
      );
      sentCount++;
    } catch {
      // skip
    }
  }

  session.nudgedMemberIds.push(...pendingIds);
  await saveSession(session);

  await ctx.editMessageText(
    `Nudge sent to ${sentCount}/${pendingIds.length} pending members.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔔 Nudge Again", `standup:nudge:${session.id}`)],
        [inlineButton("✅ Complete Standup", `standup:complete:${session.id}`)],
        [inlineButton("⬅️ Standup Menu", "standup:menu")],
      ]),
    },
  );
});

composer.callbackQuery(/^standup:complete:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match[1];
  const session = await loadSession(sessionId);

  if (!session) {
    await ctx.editMessageText("Session not found.");
    return;
  }

  const team = await loadTeam(session.teamId);
  if (!team) {
    await ctx.editMessageText("Team not found.");
    return;
  }

  session.status = "complete";
  await saveSession(session);
  await clearActiveStandup(session.teamId);

  const respondedIds = new Set(session.responses.map((r) => r.memberId));
  const pendingMemberIds = team.memberIds.filter((m) => !respondedIds.has(m));

  const memberAnswers = session.responses.map((r) => ({
    memberId: r.memberId,
    memberName: r.memberName,
    answers: r.answers,
  }));

  const blockerHighlights: string[] = [];
  for (const r of session.responses) {
    const blockerIdx = session.questions.length > 1 ? session.questions.length - 1 : 0;
    const blockerAnswer = r.answers[blockerIdx];
    if (!blockerAnswer) continue;
    const clean = blockerAnswer.trim().toLowerCase();
    if (clean === "" || clean === "no" || clean === "none" || clean === "n/a" || clean === "na" || clean === "nothing" || clean === "nope") continue;
    if (clean.startsWith("no ") || clean.startsWith("none ")) continue;
    blockerHighlights.push(`${r.memberName}: ${blockerAnswer}`);
  }

  const pendingMemberNames = pendingMemberIds.map((mid) => {
    const m = session.responses.find((r) => r.memberId === mid);
    return m ? m.memberName : `ID ${mid}`;
  });

  const digestLines: string[] = [];
  digestLines.push(`📊 Standup Digest — ${team.name} (${session.date})`);
  digestLines.push("");

  for (const r of session.responses) {
    digestLines.push(`👤 ${r.memberName}`);
    for (let i = 0; i < r.answers.length; i++) {
      digestLines.push(`  ${i + 1}. ${r.answers[i]}`);
    }
    digestLines.push("");
  }

  if (pendingMemberIds.length > 0) {
    digestLines.push(`⏳ Pending: ${pendingMemberNames.join(", ")}`);
    digestLines.push("");
  }

  if (blockerHighlights.length > 0) {
    digestLines.push("⚠️ Blockers");
    for (const b of blockerHighlights) {
      digestLines.push(`  • ${b}`);
    }
  }

  const digestText = digestLines.join("\n");

  const digest: Digest = {
    id: `digest_${Date.now()}`,
    sessionId: session.id,
    teamId: session.teamId,
    date: session.date,
    memberAnswers,
    blockerHighlights,
    pendingMemberIds,
    pendingMemberNames,
  };
  await saveDigest(digest);

  const history: HistoryEntry = {
    sessionId: session.id,
    teamId: session.teamId,
    teamName: team.name,
    date: session.date,
    memberCount: team.memberIds.length,
    responseCount: session.responses.length,
    blockerCount: blockerHighlights.length,
    status: "complete",
  };
  await saveHistoryEntry(history);

  let channelPosted = false;
  try {
    const truncated = digestText.length > 4096
      ? digestText.slice(0, 4093) + "..."
      : digestText;
    await ctx.api.sendMessage(team.channelId, truncated);
    channelPosted = true;
  } catch {
    // channel may be inaccessible in test
  }

  let summary = `✅ Standup complete for "${team.name}".\n\n` +
    `Responded: ${session.responses.length}/${team.memberIds.length}\n`;

  if (pendingMemberIds.length > 0) {
    summary += `Pending: ${pendingMemberNames.join(", ")}\n`;
  }

  if (channelPosted) {
    summary += `\nChannel digest posted.`;
  }

  await ctx.editMessageText(summary, {
    reply_markup: inlineKeyboard([
      [inlineButton("📊 Standup Menu", "standup:menu")],
      [inlineButton("⬅️ Main Menu", "menu:main")],
    ]),
  });
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (step === "answering_standup") {
    const sessionId = ctx.session.runningStandupTeamId;
    return handleStandupAnswer(ctx, sessionId);
  }

  const store = getStore();
  const activeKeys = await store.keys("active_standup:*");
  if (activeKeys.length === 0) return next();

  const userId = ctx.from?.id;
  if (!userId) return next();

  for (const key of activeKeys) {
    const sessionId = await store.get(key);
    if (!sessionId) continue;
    const session = await loadSession(sessionId);
    if (!session || session.status !== "active") continue;

    const team = await loadTeam(session.teamId);
    if (!team) continue;

    if (!team.memberIds.includes(userId)) continue;

    if (session.responses.some((r) => r.memberId === userId)) {
      continue;
    }

    return handleStandupAnswer(ctx, sessionId);
  }

  return next();
});

async function handleStandupAnswer(ctx: Ctx, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;

  const userId = ctx.from?.id;
  if (!userId) return;

  const message = ctx.message;
  if (!message || !("text" in message) || !message.text) return;

  const session = await loadSession(sessionId);
  if (!session || session.status !== "active") {
    await ctx.reply("This standup session is no longer active.");
    return;
  }

  if (session.responses.some((r) => r.memberId === userId)) {
    await ctx.reply("You've already submitted your standup. The admin will post the digest soon.");
    return;
  }

  const text = message.text.trim();
  const answers = text.split("\n").map((l) => l.replace(/^\d+[.)]\s*/, "").trim()).filter(Boolean);

  if (answers.length === 0) {
    await ctx.reply("Please send your standup answers (one per line).");
    return;
  }

  const memberName = await getMemberName(userId);
  const userName = memberName !== `ID ${userId}` ? memberName : (ctx.from?.first_name ?? `ID ${userId}`);

  const response: StandupResponse = {
    memberId: userId,
    memberName: userName,
    answers,
    submittedAt: new Date().toISOString(),
  };

  session.responses.push(response);
  await saveSession(session);

  ctx.session.step = undefined;
  ctx.session.runningStandupTeamId = undefined;

  await ctx.reply(
    "✅ Your standup has been submitted. Thanks!",
  );
}

export default composer;
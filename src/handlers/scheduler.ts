import { Composer, type Api } from "grammy";
import type { Ctx } from "../bot.js";
import { getStore } from "../store.js";
import type { Team, StandupSession, StandupResponse, Digest, HistoryEntry, Member } from "../types.js";

const composer = new Composer<Ctx>();

let botApi: Api | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

export function startScheduler(api: Api): void {
  if (intervalId) return;
  botApi = api;
  intervalId = setInterval(() => tick(), 60000);
  tick();
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  botApi = null;
}

async function loadTeams(): Promise<Team[]> {
  const store = getStore();
  const keys = await store.keys("team:*");
  const teams: Team[] = [];
  for (const k of keys) {
    const raw = await store.get(k);
    if (!raw) continue;
    teams.push(JSON.parse(raw) as Team);
  }
  return teams;
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

async function loadMember(userId: number): Promise<Member | null> {
  const store = getStore();
  const raw = await store.get(`member:${userId}`);
  if (!raw) return null;
  return JSON.parse(raw) as Member;
}

async function getMemberName(userId: number): Promise<string> {
  const member = await loadMember(userId);
  if (member) return member.displayName || `ID ${userId}`;
  return `ID ${userId}`;
}

async function getActiveStandup(teamId: string): Promise<string | null> {
  const store = getStore();
  return store.get(`active_standup:${teamId}`);
}

async function setActiveStandup(teamId: string, sessionId: string): Promise<void> {
  const store = getStore();
  await store.set(`active_standup:${teamId}`, sessionId);
}

async function clearActiveStandup(teamId: string): Promise<void> {
  const store = getStore();
  await store.del(`active_standup:${teamId}`);
}

async function saveDigest(d: Digest): Promise<void> {
  const store = getStore();
  await store.set(`digest:${d.id}`, JSON.stringify(d));
}

async function saveHistoryEntry(e: HistoryEntry): Promise<void> {
  const store = getStore();
  await store.set(`history:${e.sessionId}`, JSON.stringify(e));
}

function getTimeInTimezone(tz: string): { hour: number; minute: number; day: number } {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const dayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return { hour, minute, day: dayMap[weekday] ?? 0 };
  } catch {
    const now = new Date();
    return { hour: now.getUTCHours(), minute: now.getUTCMinutes(), day: now.getUTCDay() };
  }
}

function sameMinute(a: { hour: number; minute: number }, b: { hour: number; minute: number }): boolean {
  return a.hour === b.hour && a.minute === b.minute;
}

async function startStandup(team: Team): Promise<void> {
  if (!botApi) return;
  if (team.memberIds.length === 0) return;

  const existing = await getActiveStandup(team.id);
  if (existing) return;

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const scheduledTime = now.toISOString();
  const cutoffMinutes = team.cutoffMinutes || 120;
  const cutoff = new Date(now.getTime() + cutoffMinutes * 60 * 1000);

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

  for (const memberId of team.memberIds) {
    const member = await loadMember(memberId);
    if (member && !member.optedIn) continue;
    try {
      await botApi.sendMessage(
        memberId,
        `☀️ Standup time for "${team.name}"!\n\n` +
          questionText +
          `\n\nReply with your answers (one per line).`,
      );
    } catch {
      // skip unreachable members
    }
  }
}

async function nudgeStandup(team: Team, session: StandupSession): Promise<void> {
  if (!botApi) return;

  const nudgeTime = new Date(session.cutoffTime);
  nudgeTime.setMinutes(nudgeTime.getMinutes() - 30);
  if (new Date() < nudgeTime) return;

  const respondedIds = new Set(session.responses.map((r) => r.memberId));
  const pendingIds = team.memberIds.filter(
    (m) => !respondedIds.has(m) && !session.nudgedMemberIds.includes(m),
  );

  if (pendingIds.length === 0) return;

  for (const memberId of pendingIds) {
    try {
      await botApi.sendMessage(
        memberId,
        `⏰ Reminder: please submit your standup for "${team.name}"!\n\n` +
          session.questions
            .map((q, i) => `${i + 1}. ${q}`)
            .join("\n"),
      );
    } catch {
      // skip
    }
  }

  session.nudgedMemberIds.push(...pendingIds);
  await saveSession(session);
}

async function completeStandup(team: Team, session: StandupSession): Promise<void> {
  if (!botApi) return;

  session.status = "complete";
  await saveSession(session);
  await clearActiveStandup(team.id);

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

  let channelMessageId: number | undefined;
  try {
    const truncated = digestText.length > 4096
      ? digestText.slice(0, 4093) + "..."
      : digestText;
    const sent = await botApi.sendMessage(team.channelId, truncated);
    channelMessageId = sent.message_id;
  } catch {
    // channel may be inaccessible
  }

  const digest: Digest = {
    id: `digest_${Date.now()}`,
    sessionId: session.id,
    teamId: session.teamId,
    date: session.date,
    memberAnswers,
    blockerHighlights,
    pendingMemberIds,
    pendingMemberNames,
    channelMessageId,
  };
  await saveDigest(digest);

  const respondentNames = session.responses.map((r) => r.memberName);

  const allTextParts: string[] = [];
  for (const r of session.responses) {
    for (let i = 0; i < r.answers.length; i++) {
      allTextParts.push(`${r.memberName}: ${r.answers[i]}`);
    }
  }
  if (blockerHighlights.length > 0) {
    allTextParts.push("blockers: " + blockerHighlights.join("; "));
  }

  const history: HistoryEntry = {
    sessionId: session.id,
    teamId: session.teamId,
    teamName: team.name,
    date: session.date,
    memberCount: team.memberIds.length,
    responseCount: session.responses.length,
    memberNames: respondentNames,
    blockerCount: blockerHighlights.length,
    status: "complete",
    channelId: team.channelId,
    channelMessageId,
    allText: allTextParts.join(" | "),
  };
  await saveHistoryEntry(history);

  if (team.adminSummaryDm) {
    try {
      await botApi.sendMessage(
        team.ownerId,
        `📊 Admin summary for "${team.name}" (${session.date}):\n` +
          `Responded: ${session.responses.length}/${team.memberIds.length}\n` +
          `Blockers: ${blockerHighlights.length}\n` +
          `Pending: ${pendingMemberNames.join(", ") || "none"}`,
      );
    } catch {
      // DM may fail
    }
  }
}

async function tick(): Promise<void> {
  if (!botApi) return;

  const teams = await loadTeams();

  for (const team of teams) {
    const tzTime = getTimeInTimezone(team.timezone);
    const scheduledHour = team.scheduledHour ?? 9;
    const scheduledMinute = team.scheduledMinute ?? 0;

    if (!team.workingDays.includes(tzTime.day)) continue;

    const activeSessionId = await getActiveStandup(team.id);

    if (!activeSessionId) {
      if (sameMinute(tzTime, { hour: scheduledHour, minute: scheduledMinute })) {
        await startStandup(team);
      }
      continue;
    }

    const session = await loadSession(activeSessionId);
    if (!session) {
      await clearActiveStandup(team.id);
      continue;
    }

    if (session.status !== "active") continue;

    if (new Date().toISOString() >= session.cutoffTime) {
      await completeStandup(team, session);
      continue;
    }

    const nudgeTime = new Date(session.cutoffTime);
    nudgeTime.setMinutes(nudgeTime.getMinutes() - 30);
    if (new Date() >= nudgeTime) {
      await nudgeStandup(team, session);
    }
  }
}

export default composer;

export interface Team {
  id: string;
  name: string;
  channelId: number;
  workingDays: number[];
  timezone: string;
  questions: string[];
  memberIds: number[];
  ownerId: number;
}

export interface Member {
  telegramId: number;
  displayName: string;
  timezone: string;
  optedIn: boolean;
  skipFlags: string[];
}

export interface StandupResponse {
  memberId: number;
  memberName: string;
  answers: string[];
  submittedAt: string;
}

export interface StandupSession {
  id: string;
  teamId: string;
  date: string;
  scheduledTime: string;
  cutoffTime: string;
  questions: string[];
  responses: StandupResponse[];
  nudgedMemberIds: number[];
  status: "pending" | "active" | "complete";
}

export interface Digest {
  id: string;
  sessionId: string;
  teamId: string;
  date: string;
  memberAnswers: Array<{ memberId: number; memberName: string; answers: string[] }>;
  blockerHighlights: string[];
  pendingMemberIds: number[];
  pendingMemberNames: string[];
}

export interface HistoryEntry {
  sessionId: string;
  teamId: string;
  teamName: string;
  date: string;
  memberCount: number;
  responseCount: number;
  blockerCount: number;
  status: string;
}

export const DEFAULT_QUESTIONS = [
  "What did you work on yesterday?",
  "What are you working on today?",
  "Any blockers or challenges?",
];

export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

export const DEFAULT_TIMEZONE = "UTC";
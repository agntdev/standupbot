# StandupBot — Bot specification

**Archetype:** workflow

Automates asynchronous daily standups for distributed teams via Telegram. Sends private questions to members, collects answers, nudges non-responders, and publishes a consolidated digest to a team channel with history tracking and search.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Team leads/managers
- Distributed team members

## Success criteria

- Daily digests posted to team channel on schedule
- 100% response tracking accuracy with pending/skipped visibility
- Searchable history of all standup sessions

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with team setup/history options
- **Create Team** (button, actor: owner, callback: team:create) — Initialize new team configuration
  - inputs: team name, channel ID, working days, timezone rules
  - outputs: team configuration saved
- **View History** (button, actor: user, callback: history:view) — Search past standups by date/member/blocker
  - inputs: date range, member name, keyword
  - outputs: session permalink

## Flows

### Daily Standup Cycle
_Trigger:_ scheduled time (member timezone)

1. Send private questions to all active members
2. Collect responses until cutoff time
3. Send single nudge to non-responders
4. Generate digest when cutoff reached
5. Post digest to team channel

_Data touched:_ Team, Member, Standup Session, Digest

### History Access
_Trigger:_ /history command

1. Parse filter parameters
2. Retrieve matching sessions
3. Generate permalink summary

_Data touched:_ History Entry

### Admin Controls
_Trigger:_ Owner command/button

1. Update team configuration
2. Modify member list
3. Adjust schedule parameters

_Data touched:_ Team, Member

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Team** _(retention: persistent)_ — Team configuration and membership data
  - fields: name, channel ID, working days, timezone rules, questions, member list
- **Member** _(retention: persistent)_ — User profile and participation status
  - fields: Telegram ID, display name, timezone, opt-in status, skip flags
- **Standup Session** _(retention: persistent)_ — Daily standup execution data
  - fields: date, scheduled time, cutoff time, questions, responses, nudged status, blocker tags
- **Digest** _(retention: persistent)_ — Consolidated session summary for posting
  - fields: session metadata, member answers, blocker highlights, pending list
- **History Entry** _(retention: persistent)_ — Archived session data for search
  - fields: session ID, full responses, metadata

## Integrations

- **Telegram** (required) — Private messages and channel posting
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Create/edit teams
- Configure working days/schedules
- Add/remove members
- Customize questions
- Toggle opt-in requirements

## Notifications

- Digest posted to team channel
- Optional admin summary DM (configurable)

## Permissions & privacy

- Members must opt-in to participate
- Responses tied to user identity
- No anonymous submissions

## Edge cases

- Members without timezone set
- Late responses after cutoff
- Partial answers in single-message reply
- Channel access permissions

## Required tests

- End-to-end digest generation with all response states
- Nudge timing accuracy across timezones
- History search with multiple filters

## Assumptions

- Default questions used if not customized
- Single nudge 30min before cutoff
- Cutoff defaults to 2h after scheduled time
- Owner is sole admin initially

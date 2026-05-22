# Summary/Digest Taxonomy for Telegram Group Chat Bot

## 1. Taxonomy Overview

Summary types are organized into 5 categories based on what they capture:

| Category | Types | Primary Value |
|----------|-------|---------------|
| **Action & Decisions** | Action Items, Decisions Made, Consensus Reached, Unanswered Questions | Accountability & follow-through |
| **Knowledge & Insights** | New Facts Discovered, Key Insights, Resources & Links, Definitions & Clarifications | Information retention |
| **Discussion Dynamics** | Viewpoint Highlights, Controversial Points, Sentiment Shifts, Topic Changes | Understanding conversation texture |
| **Announcements & Meta** | Announcements, Scheduled Events, Polls & Votes, Meta-Discussion | Coordination & governance |
| **Social & Engagement** | Engagement Spikes, Member Milestones, Humor & Off-topic Highlights | Community health |

---

## 2. Detailed Type Specifications

### 2.1 Action & Decisions

#### **Action Items**
- **Definition**: Concrete tasks assigned to specific people with implicit or explicit deadlines.
- **Trigger Conditions**: 
  - Message contains assignment patterns ("@username needs to...", "can you handle...", "I'll take care of...")
  - Imperative statements following a decision
  - Messages with date/deadline references near task language
- **Detection Strategy**:
  - **Rule-based**: Regex for assignment patterns, deadline keywords ("by tomorrow", "EOD", "next week"), checkmark/cross emoji
  - **LLM**: Classify if message contains a task, extract assignee (explicit or inferred from thread context), extract deadline if any, assess urgency
- **Priority Score**: High (0.9) — actionable items are the highest-value content to surface
- **LLM Prompt**:
  ```
  Analyze the following chat message(s). Identify any action items — tasks someone needs to complete.
  For each action item, extract:
  - Task description (max 15 words)
  - Assignee: explicit (@user) or inferred from context
  - Deadline: explicit date/time or relative term ("by Friday", "ASAP")
  - Source message URL or ID
  
  Return JSON array. If none found, return empty array.
  ```

#### **Decisions Made**
- **Definition**: Points where the group converged on a choice, resolution, or definitive statement.
- **Trigger Conditions**:
  - Conclusive language ("let's go with...", "decided to...", "we'll use...", "agreed that...")
  - Admin/owner definitive statements
  - Messages following extended debate that introduce closure
- **Detection Strategy**:
  - **Rule-based**: Decision keywords, admin badge + imperative, poll conclusion
  - **LLM**: Determine if a message represents a final position (vs. ongoing discussion). Score confidence (0-1). Distinguish from " Consensus Reached" — decisions can be unilateral.
- **Priority Score**: High (0.85)
- **LLM Prompt**:
  ```
  Analyze the message thread. Identify statements that represent a finalized decision — 
  a choice, resolution, or definitive commitment made by one or more participants.
  
  For each decision:
  - Decision summary (1 sentence)
  - Decision maker(s) or authoritative source
  - Confidence: high (explicit "we decided"), medium (implied closure), low (suggested but not confirmed)
  - Context: what problem or question this resolved
  
  Exclude opinions, ongoing debates, and suggestions without closure.
  Return JSON array.
  ```

#### **Consensus Reached**
- **Definition**: Broad agreement among multiple participants, distinct from unilateral decisions.
- **Trigger Conditions**:
  - Multiple participants using agreement signals ("+1", "agree", "makes sense", "let's do it")
  - Absence of objections following a proposal
  - Poll results with clear majority (>70%)
- **Detection Strategy**:
  - **Rule-based**: Count agreement reactions/keywords in a thread segment
  - **LLM**: Analyze thread for convergence patterns — multiple participants aligning on same position. Detect "silent consensus" (proposal followed by topic shift with no objections).
- **Priority Score**: Medium-High (0.8)
- **LLM Prompt**:
  ```
  Analyze the conversation thread for consensus moments — points where 2+ participants 
  converge on agreement without significant remaining dissent.
  
  For each consensus:
  - Topic or proposal agreed upon
  - Participants who expressed agreement (explicit or via emoji reactions)
  - Consensus strength: unanimous / strong majority / weak majority
  - Any remaining dissent or reservations noted
  
  Distinguish from "Decision Made" — consensus emphasizes group alignment, not just closure.
  Return JSON array.
  ```

#### **Unanswered / Pending Questions**
- **Definition**: Questions posed to the group that received no substantive response or resolution.
- **Trigger Conditions**:
  - Question mark + no reply within N messages or N minutes
  - Tagged questions ("@admin how do we...") with no response from target
  - Follow-up messages indicating the question was ignored ("anyone?", "bumping this")
- **Detection Strategy**:
  - **Rule-based**: Question detection (question marks, WH-words), time-based tracking, no-reply counter
  - **LLM**: Classify if a message is a genuine question (vs. rhetorical). Check if subsequent messages answer it. Assess question urgency/priority based on content (blocking vs. curiosity).
- **Priority Score**: High (0.85) — these are conversation leaks that need follow-up
- **LLM Prompt**:
  ```
  Identify questions in the conversation that remain unanswered or unresolved.
  A question is "unanswered" if no subsequent message provides a substantive answer, 
  clarification, or action that addresses it.
  
  For each:
  - Question text (paraphrased)
  - Asker
  - Time since asked (if available)
  - Urgency: blocking (prevents progress) / informational / curiosity
  - Who should answer: specific person tagged, domain expert needed, anyone
  
  Filter out rhetorical questions, answered questions, and clearly resolved items.
  Return JSON array.
  ```

---

### 2.2 Knowledge & Insights

#### **New Facts Discovered**
- **Definition**: Novel information, data points, or findings introduced to the group.
- **Trigger Conditions**:
  - Statements presenting new information ("I found out that...", "Turns out...", "Data shows...")
  - External source references with synthesis (not just link dumps)
  - Corrections to previous group assumptions
- **Detection Strategy**:
  - **Rule-based**: Discovery keywords, URL sharing with explanatory text, correction patterns ("actually...", "not true — ...")
  - **LLM**: Determine novelty — is this genuinely new to the conversation context or just repeating known info? Extract the core fact and its source/reliability.
- **Priority Score**: Medium (0.7)
- **LLM Prompt**:
  ```
  Extract novel facts or findings introduced in this conversation segment.
  A "new fact" is information that appears to be introduced for the first time, 
  changes a previous understanding, or comes from external research/data.
  
  For each:
  - Fact summary (1-2 sentences)
  - Source: URL, person who shared it, "personal experience", "external research"
  - Reliability: stated as fact / educated guess / hearsay / data-backed
  - Whether it corrects a previous group assumption
  
  Exclude widely known trivia, opinions dressed as facts without basis, and previously shared info.
  Return JSON array.
  ```

#### **Key Insights**
- **Definition**: Non-obvious conclusions, pattern recognition, or strategic takeaways derived from discussion.
- **Trigger Conditions**:
  - Synthesis statements ("The pattern here is...", "What this means is...", "The takeaway...")
  - Messages that reframe the conversation or elevate it to a higher level of abstraction
  - "Aha" moments — replies expressing realization ("oh I see now...", "that explains...")
- **Detection Strategy**:
  - **Rule-based**: Insight keywords, reframing patterns, realization expressions
  - **LLM**: Evaluate if a message provides a non-obvious conclusion that connects multiple prior points. Distinguish from mere opinions — insights have explanatory or predictive power.
- **Priority Score**: Medium-High (0.75)
- **LLM Prompt**:
  ```
  Identify key insights — non-obvious conclusions, pattern recognition, or strategic 
  realizations that emerge from the discussion.
  
  For each:
  - Insight summary (1-2 sentences)
  - Insight originator
  - Basis: what conversation elements led to this insight
  - Type: pattern recognition / causal explanation / strategic implication / reframing
  - Depth: surface-level observation vs. genuinely non-obvious connection
  
  Filter out generic opinions, restatements of facts, and platitudes.
  Return JSON array.
  ```

#### **Resources & Links Shared**
- **Definition**: Shared URLs, files, documents, or references with contextual value.
- **Trigger Conditions**:
  - URL sharing, file uploads, forwarded messages with external content
  - Messages explicitly offering resources ("here's the doc...", "check out this tool...")
- **Detection Strategy**:
  - **Rule-based**: URL regex, file attachment detection, resource keywords
  - **LLM**: Categorize link type (documentation, tool, article, media, data). Extract description if provided. Assess relevance to group purpose.
- **Priority Score**: Low-Medium (0.5)
- **LLM Prompt**:
  ```
  Extract all shared resources — URLs, files, documents, tools, references.
  
  For each:
  - URL or resource identifier
  - Category: documentation / tool / article / media / dataset / reference / other
  - Description: what was shared (extract from message context or generate from URL if obvious)
  - Sharer
  - Relevance to group: high (directly on-topic) / medium / low (off-topic or casual)
  
  Deduplicate by URL. Return JSON array.
  ```

#### **Definitions & Clarifications**
- **Definition**: Moments where terminology, scope, or concepts are explicitly defined for shared understanding.
- **Trigger Conditions**:
  - "What do we mean by..." followed by explanation
  - Acronym expansion or jargon clarification
  - Scope boundary definitions ("for this project, X means...")
- **Detection Strategy**:
  - **Rule-based**: Definition patterns ("X is...", "by X we mean...", "X = ..."), question-answer pairs about terminology
  - **LLM**: Detect if a message resolves ambiguity or establishes shared vocabulary.
- **Priority Score**: Medium (0.6)
- **LLM Prompt**:
  ```
  Identify definitions, clarifications, or scope boundaries established in the conversation.
  
  For each:
  - Term or concept defined
  - Definition text
  - Who provided it
  - Trigger: was this in response to confusion, proactive clarification, or debate resolution?
  
  Return JSON array.
  ```

---

### 2.3 Discussion Dynamics

#### **Viewpoint Highlights**
- **Definition**: Notable perspectives, arguments, or positions expressed by participants in a debate.
- **Trigger Conditions**:
  - Multi-party discussion with conflicting or complementary positions
  - Messages that introduce a new angle or dimension to a debate
  - Well-reasoned arguments (length + structure indicators)
- **Detection Strategy**:
  - **Rule-based**: Thread depth > 3 replies, contrastive language ("but...", "however...", "on the other hand...")
  - **LLM**: Map the "argument landscape" — identify distinct positions, their proponents, and key supporting points. Extract the strongest argument for each position.
- **Priority Score**: Medium (0.65)
- **LLM Prompt**:
  ```
  Map the viewpoints expressed in this discussion thread.
  
  For each distinct position or perspective:
  - Position summary (1 sentence)
  - Proponent(s)
  - Key argument (max 2 sentences)
  - Strength: well-reasoned / emotional / anecdotal / speculative
  - Whether it's a new perspective or reinforcement of existing one
  
  Aim to capture 2-4 distinct viewpoints. If discussion is consensus-only, note that.
  Return JSON array with positions and a brief "debate summary" field.
  ```

#### **Controversial Points**
- **Definition**: Topics or statements that generated significant disagreement, pushback, or heated exchange.
- **Trigger Conditions**:
  - Rapid reply chains with negative sentiment
  - Multiple participants directly contradicting each other
  - Message edit history suggesting walkbacks or clarifications after pushback
  - Admin/mod intervention in a thread
- **Detection Strategy**:
  - **Rule-based**: Sentiment drop, reply velocity spike, negation density, admin intervention detection
  - **LLM**: Identify points of friction — where do participants fundamentally disagree? Assess if controversy is productive (clarifying) or destructive (personal).
- **Priority Score**: Medium (0.7) — important for group health monitoring
- **LLM Prompt**:
  ```
  Identify controversial or contentious points in the conversation.
  A "controversial point" is a statement, proposal, or topic that generated 
  significant pushback, disagreement, or heated exchange.
  
  For each:
  - Controversial statement or topic
  - Sides: who is arguing for/against what
  - Heat level: mild disagreement / substantive debate / heated conflict / personal
  - Productivity: clarifying (leads to understanding) or destructive (leads to animosity)
  - Resolution status: resolved / ongoing / unresolved / tabled
  
  Return JSON array.
  ```

#### **Sentiment Shifts**
- **Definition**: Notable changes in the emotional tone of the conversation — positive spikes, negative dips, or recovery arcs.
- **Trigger Conditions**:
  - Aggregated sentiment score crossing thresholds (+0.5 to -0.5 or vice versa)
  - Individual messages with extreme sentiment (e.g., celebration, frustration, apology)
  - Sudden topic changes following negative sentiment (topic avoidance)
- **Detection Strategy**:
  - **Rule-based**: Emoji density analysis (celebration vs. anger emojis), exclamation patterns, capitalization spikes
  - **LLM**: Score sentiment per message (-1 to +1). Detect inflection points where conversation tone changes significantly. Identify catalyst messages.
- **Priority Score**: Low-Medium (0.55) — context for other summary types
- **LLM Prompt**:
  ```
  Analyze the emotional arc of this conversation segment.
  
  For each sentiment shift:
  - Before: prevailing sentiment
  - After: new prevailing sentiment
  - Catalyst: message or event that triggered the shift
  - Magnitude: subtle / moderate / dramatic
  - Duration: momentary spike / sustained shift
  - Contributing factors: what content drove the change
  
  Return JSON array of shifts. If tone is stable, return empty array.
  ```

#### **Topic Changes**
- **Definition**: Moments when the conversation shifts to a new subject, fork into parallel threads, or return to previous topics.
- **Trigger Conditions**:
  - Semantic vector drift between consecutive messages exceeds threshold
  - Explicit topic declarations ("changing subject...", "on another note...")
  - Interleaving of unrelated conversations (parallel threads)
- **Detection Strategy**:
  - **Rule-based**: Keyword overlap analysis between messages, explicit transition phrases
  - **LLM**: Track topic coherence. Identify pivot messages. Tag topics with short labels.
- **Priority Score**: Low (0.45) — primarily structural metadata
- **LLM Prompt**:
  ```
  Identify topic changes and conversation forks in the message sequence.
  
  For each topic boundary:
  - Previous topic label (3-5 words)
  - New topic label (3-5 words)
  - Pivot message: what triggered the shift
  - Type: natural evolution / abrupt change / parallel thread / return to previous topic
  - Fork depth: 0 (linear) / 1 (one side thread) / 2+ (complex branching)
  
  Return JSON array.
  ```

---

### 2.4 Announcements & Meta

#### **Announcements**
- **Definition**: Formal or important notifications from admins, bots, or members about changes, updates, or events.
- **Trigger Conditions**:
  - Admin/bot messages with broadcast character
  - Messages with announcement formatting (all-caps headers, emoji bullet lists, pinned message references)
  - Messages starting with authoritative framing ("Important:", "Notice:", "Update:")
- **Detection Strategy**:
  - **Rule-based**: Sender role (admin/bot), formatting patterns, announcement keywords
  - **LLM**: Classify broadcast intent. Extract what is being announced, who it affects, and any required action.
- **Priority Score**: High (0.9) — announcements are time-sensitive
- **LLM Prompt**:
  ```
  Identify announcements — formal or important notifications that require group attention.
  
  For each:
  - Announcement summary
  - Announcer: admin / bot / member with authority / regular member
  - Urgency: immediate action needed / time-sensitive / informational / FYI
  - Audience: who needs to know
  - Required action: none / acknowledgment / specific task / attendance
  
  Return JSON array.
  ```

#### **Scheduled Events / Meetings**
- **Definition**: References to future meetings, deadlines, events, or time-bound activities.
- **Trigger Conditions**:
  - Date/time mentions in future tense with event context
  - Calendar links, poll-based scheduling ("When can everyone meet?")
  - Recurring event references ("the daily standup", "next sprint planning")
- **Detection Strategy**:
  - **Rule-based**: Temporal parsing (date/time extraction), event keywords ("meeting", "call", "deadline", "launch")
  - **LLM**: Extract event details, participants, and temporal context. Distinguish scheduled events from casual future references.
- **Priority Score**: Medium-High (0.8)
- **LLM Prompt**:
  ```
  Extract scheduled events, meetings, deadlines, or time-bound activities mentioned.
  
  For each:
  - Event description
  - Date and time (normalized if possible)
  - Participants or target audience
  - Event type: meeting / deadline / milestone / social / reminder
  - Location/link if mentioned
  - Organizer
  
  Return JSON array.
  ```

#### **Polls & Votes**
- **Definition**: Formal or informal polls, voting sessions, or preference gathering.
- **Trigger Conditions**:
  - Telegram native polls
  - Informal voting patterns ("Option A or B?", react with emoji to vote)
  - Straw poll language ("quick poll:", "vote:")
- **Detection Strategy**:
  - **Rule-based**: Telegram poll API events, emoji reaction voting patterns, poll keywords
  - **LLM**: Extract options, current results (if concluded), and what is being decided.
- **Priority Score**: Medium (0.75)
- **LLM Prompt**:
  ```
  Identify polls, votes, or preference-gathering activities.
  
  For each:
  - Question or decision being polled
  - Options
  - Results if concluded (or "ongoing" if active)
  - Turnout: how many participated
  - Format: Telegram native poll / emoji reactions / informal text vote
  
  Return JSON array.
  ```

#### **Meta-Discussion**
- **Definition**: Conversations about the group itself — rules, moderation, structure, or culture.
- **Trigger Conditions**:
  - Messages about group rules, admin actions, channel organization
  - "Should we create a separate channel for..." type proposals
  - Feedback about group dynamics or bot behavior
- **Detection Strategy**:
  - **Rule-based**: Meta keywords ("this group", "channel", "rules", "off-topic", "moderation")
  - **LLM**: Classify self-referential discussion about group governance or culture.
- **Priority Score**: Medium (0.6)
- **LLM Prompt**:
  ```
  Identify meta-discussion — conversation about the group itself, its rules, 
  structure, moderation, or culture.
  
  For each:
  - Meta-topic: rules / organization / moderation / culture / tools / other
  - Proposal or issue raised
  - Any consensus or decision reached
  - Action items resulting from meta-discussion
  
  Return JSON array.
  ```

---

### 2.5 Social & Engagement

#### **Engagement Spikes**
- **Definition**: Periods of unusually high activity — rapid-fire messages, many participants engaging simultaneously.
- **Trigger Conditions**:
  - Message rate exceeds 2x rolling average
  - Burst of 5+ messages within 2 minutes from 3+ different users
  - Reaction flood on a single message (>10 reactions)
- **Detection Strategy**:
  - **Purely rule-based**: Time-series analysis of message volume and participant diversity
  - **LLM**: Contextualize — what triggered the spike? Identify the "spark message."
- **Priority Score**: Low (0.4) — unless spike correlates with another high-priority type
- **LLM Prompt**:
  ```
  Identify engagement spikes — periods of unusually high message volume or participation.
  
  For each:
  - Time window
  - Message count and participant count
  - Trigger: what message or event started the spike
  - Topic of the spike
  - Whether it was productive or noisy
  
  Return JSON array.
  ```

#### **Member Milestones**
- **Definition**: Welcomes, goodbyes, achievements, or significant member activity markers.
- **Trigger Conditions**:
  - New member join events + welcome messages
  - Explicit farewells or departures
  - Achievement mentions ("congrats on...", "happy anniversary", "promotion")
- **Detection Strategy**:
  - **Rule-based**: Telegram join/leave events, congratulatory keywords
  - **LLM**: Detect celebration context and milestone significance.
- **Priority Score**: Low (0.35) — social glue, can be batched
- **LLM Prompt**:
  ```
  Identify member milestones — welcomes, farewells, achievements, or other 
  significant member events.
  
  For each:
  - Member(s) involved
  - Milestone type: join / leave / achievement / anniversary / role change / other
  - Context summary
  - Community reaction
  
  Return JSON array.
  ```

#### **Humor & Off-topic Highlights**
- **Definition**: Notable funny, casual, or off-topic exchanges that contribute to group culture.
- **Trigger Conditions**:
  - Clusters of laughter reactions (😂, 🤣, lol, lmao)
  - Explicit "off-topic" tags or channel references
  - Meme/image sharing with positive reactions
- **Detection Strategy**:
  - **Rule-based**: Reaction analysis, humor keywords, image-to-text ratios in threads
  - **LLM**: Classify if a message/thread is primarily humor/off-topic vs. substantive. Extract the "highlight" if it's culturally significant.
- **Priority Score**: Very Low (0.2) — entertainment, not information
- **LLM Prompt**:
  ```
  Identify humor, memes, or off-topic highlights that generated significant 
  positive reactions or contributed to group culture.
  
  For each:
  - Type: meme / joke / banter / off-topic tangent / other
  - Summary
  - Key participants
  - Reaction magnitude (e.g., "15 😂 reactions")
  - Cultural relevance: inside joke / recurring bit / one-off funny moment
  
  Include only highlights with notable engagement. Skip mundane casual chat.
  Return JSON array.
  ```

---

## 3. Extraction & Classification Architecture

### 3.1 Two-Layer Detection System

```
Raw Messages
    ↓
┌─────────────────────────────────────────┐
│ Layer 1: Rule-Based Fast Filter         │
│ - Regex patterns (questions, URLs,      │
│   decisions, assignments, time refs)    │
│ - Heuristic scoring (sentiment,         │
│   engagement rate, topic drift)         │
│ - Telegram metadata (polls, joins,      │
│   admin status, edits, reactions)        │
│ Output: Candidate segments + type hints │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Layer 2: LLM Deep Analysis              │
│ - Contextual classification             │
│ - Entity extraction                     │
│ - Semantic deduplication                │
│ - Priority scoring                      │
│ - Cross-reference generation            │
│ Output: Structured summary items         │
└─────────────────────────────────────────┘
    ↓
Combined Digest Assembly
```

### 3.2 Per-Message vs. Window-Based Analysis

| Approach | When to Use | Trade-offs |
|----------|-------------|------------|
| **Per-message** | Action items, announcements, questions, resources | Fast, low context, may miss implied information |
| **Sliding window** (5-10 messages) | Viewpoints, controversial points, topic changes | Captures local context, moderate cost |
| **Thread-based** | Decisions, consensus, deep insights | Full thread context, higher cost, best accuracy |
| **Session-based** (full period) | Sentiment arcs, engagement spikes, meta patterns | Global context, highest cost, batch-only |

**Hybrid Strategy**:
1. Run per-message classification on every message (fast, lightweight)
2. Accumulate messages into dynamic windows when reply chains form (sliding window)
3. When a thread concludes (quiet period > 10 min or topic change detected), run thread-level analysis
4. At digest generation time, run session-level synthesis for cross-cutting types (sentiment, engagement)

### 3.3 Real-Time vs. Batched Triggers

**Real-Time Triggers** (immediate notification-worthy):
| Trigger | Condition | Summary Types |
|---------|-----------|---------------|
| **Urgent unanswered question** | Question + @admin + 30 min no reply | Unanswered Questions |
| **Decision made** | Admin definitive statement or explicit "decided" | Decisions Made |
| **Announcement** | Admin/bot message with broadcast intent | Announcements |
| **Action item assigned** | Explicit assignment with deadline < 24h | Action Items |
| **Controversy spike** | Sentiment drop + reply velocity spike | Controversial Points |
| **Emergency sentiment** | Extreme negative sentiment from key member | Sentiment Shifts |

**Batched Triggers** (periodic digest):
| Trigger | Window | Summary Types |
|---------|--------|---------------|
| **Hourly digest** | 1 hour, min 5 messages | All types, priority > 0.6 |
| **Daily digest** | 24 hours | All types, full spectrum |
| **Quiet-period digest** | After 30+ min inactivity | Thread completions, decisions, unanswered questions |
| **Volume-based digest** | Every 50 messages | Engagement spikes, topic changes, viewpoint highlights |
| **End-of-event digest** | After scheduled meeting/event | Decisions, action items, consensus, resources |

### 3.4 Deduplication Strategy

**Semantic Deduplication Pipeline**:
1. **Exact match**: Same message ID, URL, or verbatim text → discard duplicate
2. **Entity overlap**: If two summary items reference the same core entity (same question, same decision, same link) within a 4-hour window → merge or keep higher-confidence version
3. **Semantic similarity**: Embed summary items (using lightweight embeddings), cosine similarity > 0.85 → merge with richer context
4. **Temporal exclusion**: Don't re-summarize the same thread segment in consecutive digests; mark items with `first_seen_at` and `last_updated_at`
5. **Progressive updates**: If a previous "Unanswered Question" gets answered, update it to "Resolved" rather than creating a new "Decision" item — maintain item identity across digests

**Deduplication Prompt**:
```
You are deduplicating summary items for a Telegram digest.

Given an existing item and a candidate new item, determine:
- DUPLICATE: same entity, discard new
- UPDATE: same entity with new information, merge into existing
- RELATED: connected but distinct, add cross-reference
- NEW: genuinely new item, add to digest

Return JSON with verdict and merged/updated content if applicable.
```

### 3.5 Priority & Scoring System

Each summary item gets a composite score:

```
Priority Score = Base_Type_Priority × Urgency_Factor × Novelty_Factor × Authority_Factor
```

| Factor | Range | How Computed |
|--------|-------|--------------|
| **Base Type Priority** | 0.2 - 0.9 | From type taxonomy (see each type's score) |
| **Urgency Factor** | 0.5 - 1.5 | Time sensitivity (deadline proximity, real-time trigger) |
| **Novelty Factor** | 0.5 - 1.5 | Semantic distance from previously summarized items |
| **Authority Factor** | 0.8 - 1.2 | Sender role (admin=1.2, regular=1.0, bot=0.9) |

**Score Thresholds for Inclusion**:
- **Real-time alerts**: Priority >= 1.0
- **Hourly digest**: Priority >= 0.6
- **Daily digest**: Priority >= 0.4
- **Full archive**: All items

---

## 4. Combined Digest Assembly

### 4.1 Digest Structure Template

```markdown
# Chat Digest: [Group Name] — [Time Window]

## 🔴 Requires Attention (Priority >= 0.8)
- **Unanswered Questions** (2)
  - [Question] — asked by @user, 2 hours ago
  - [Question] — asked by @admin, blocking, 30 min ago
- **Action Items** (1)
  - [Task] — assigned to @user, due tomorrow

## 🟡 Key Developments (Priority 0.6 - 0.8)
- **Decisions Made** (1)
  - [Decision summary] — by @admin
- **New Facts** (2)
  - [Fact 1] — source: URL
  - [Fact 2] — source: @user's research
- **Consensus Reached** (1)
  - [Topic] — 4/5 participants agree

## 🟢 Discussion Highlights (Priority < 0.6)
- **Viewpoints** (3 positions on [Topic])
  - Position A: ... (@user1)
  - Position B: ... (@user2)
  - Position C: ... (@user3)
- **Resources Shared** (4)
  - [Link 1] — shared by @user
  - ...

## 📊 Conversation Metadata
- **Sentiment Arc**: Started neutral → dipped negative (controversy at 14:30) → recovered positive
- **Topic Changes**: 3 (Project X → Tools discussion → Off-topic → Back to Project X)
- **Engagement**: 45 messages from 8 participants (1.5x average)

## 🔗 Cross-References
- Decision "[X]" resolves Unanswered Question "[Y]"
- Controversy about [Topic] led to Consensus on [Sub-topic]
- Action Item [Z] references Resource [W]
```

### 4.2 Cross-Reference Generation

After extracting individual items, run a linking pass:

```
Given these extracted summary items, identify relationships:
- RESOLVES: a decision/consensus/answer that resolves a question/controversy
- DEPENDS_ON: an action item that depends on a decision or resource
- CONTRADICTS: a new fact that contradicts a previous decision/assumption
- EXPANDS_ON: an insight that elaborates on a previous fact
- TRIGGERED: a sentiment shift or engagement spike triggered by a specific announcement/controversy

Return JSON array of edges: {from, to, relation_type, explanation}
```

### 4.3 Format Adaptations by Channel

| Output Channel | Adaptation |
|----------------|------------|
| **Telegram Message** | Emoji headers, bullet points, max 4000 chars, inline mentions |
| **Telegram Channel Post** | Richer formatting, pinned digest, threaded replies for details |
| **Email** | Full structure, tables, longer descriptions |
| **Slack/Discord** | Block quotes, thread links, reaction-based voting |
| **Dashboard** | Filterable, sortable, time-series visualization |

### 4.4 Progressive Disclosure

For real-time digests, use progressive detail:
1. **One-line summary** (always shown): "2 unanswered questions, 1 decision made, 3 resources shared"
2. **Expandable section** (tap to expand): Item list with 1-sentence descriptions
3. **Full detail** (link or thread): Complete extraction with context and cross-references

---

## 5. Implementation Notes

### 5.1 Message Context Window

For LLM analysis, include:
- Message text (required)
- Sender username/role (required)
- Timestamp (required)
- Reply-to message ID (if threaded)
- Reactions (emoji counts)
- Edit history flag (was message edited?)
- Forward origin (if forwarded)

### 5.2 Language Considerations

- Run detection in the language of the chat (multilingual groups may need language detection per message)
- Key patterns (questions, decisions, assignments) are language-dependent — maintain pattern libraries per language
- LLM prompts should specify the chat language for better extraction accuracy

### 5.3 Group-Specific Calibration

- **Technical teams**: Boost "Decisions", "Action Items", "Resources" priority; reduce "Social"
- **Community/social groups**: Boost "Sentiment", "Engagement", "Controversy"; reduce "Action Items"
- **Support channels**: Boost "Unanswered Questions", "Definitions", "Announcements"
- **Project teams**: Boost "Decisions", "Consensus", "Action Items", "Topic Changes"

### 5.4 Confidence & Fallback

Each extracted item should have a confidence score:
- **High (0.8-1.0)**: Clear signal, multiple indicators, explicit language
- **Medium (0.5-0.8)**: Implied signal, requires context, some ambiguity
- **Low (0.3-0.5)**: Weak signal, ambiguous, may be noise

Items below 0.3 confidence should be dropped or flagged for human review.

---

## 6. Summary Type Quick Reference

| Type | Base Priority | Trigger | Detection | Real-Time? |
|------|---------------|---------|-----------|------------|
| Action Items | 0.90 | Assignments, deadlines | Assignment regex + LLM | Yes (if urgent) |
| Decisions Made | 0.85 | Closure language | Decision keywords + LLM | Yes |
| Unanswered Questions | 0.85 | Question + no reply | Question regex + time tracking | Yes (if blocking) |
| Announcements | 0.90 | Admin/bot broadcast | Role + formatting + keywords | Yes |
| Scheduled Events | 0.80 | Future time references | Temporal parsing + event keywords | No |
| Consensus Reached | 0.80 | Agreement convergence | Agreement counting + LLM | No |
| Key Insights | 0.75 | Synthesis statements | Insight keywords + LLM | No |
| Polls & Votes | 0.75 | Poll events, voting patterns | API events + reaction analysis | Yes (if concluded) |
| New Facts | 0.70 | Novel information | Discovery keywords + LLM | No |
| Controversial Points | 0.70 | Disagreement spike | Sentiment + reply velocity | Yes (if heated) |
| Definitions | 0.60 | Clarification patterns | Definition keywords + LLM | No |
| Meta-Discussion | 0.60 | Self-referential talk | Meta keywords + LLM | No |
| Viewpoint Highlights | 0.65 | Multi-party debate | Thread depth + contrastive lang | No |
| Sentiment Shifts | 0.55 | Tone inflection points | Sentiment scoring + LLM | No |
| Topic Changes | 0.45 | Subject shifts | Semantic drift + keywords | No |
| Engagement Spikes | 0.40 | Volume anomalies | Message rate + participant count | No |
| Member Milestones | 0.35 | Joins, achievements | API events + congratulatory keywords | No |
| Humor/Off-topic | 0.20 | High reaction casual chat | Reaction analysis + LLM | No |

---

*This taxonomy is designed to be extensible — new summary types can be added by defining their detection signals, extraction prompts, and priority scores within the same framework.*

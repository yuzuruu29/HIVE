# HIVE Demo Script (60–90 Seconds)

**Title:** HIVE — Hyper Intelligence for Verified Engineering
**Goal:** Demonstrate the verified engineering loop from task creation to explicit approval, emphasizing safety and orchestrator transparency.

## 0:00 – 0:10 | Initialization
1. **Action:** Open terminal in the `hive-mind` monorepo.
2. **Action:** Run `npm run dev:all` (or start API and Web separately).
3. **Narration:** *"Welcome to HIVE — Hyper Intelligence for Verified Engineering. HIVE is an open-source agentic coding orchestrator built to plan, build, test, and review code in a verified loop."*

## 0:10 – 0:25 | Task Creation
1. **Action:** Open browser to `http://localhost:3000/coder`.
2. **Action:** Enter a simple prompt in the task input, like *"Add a generic ping endpoint to the API routes"* and click **Start Task**.
3. **Narration:** *"We initiate a task. Immediately, HIVE spins up an isolated git worktree so our main branch remains completely untouched while agents work."*

## 0:25 – 0:50 | The Council Loop (Transcripts)
1. **Action:** Click through the active **Planner**, **Builder**, **Validator**, and **Reviewer** transcript tabs in the UI as the task runs.
2. **Narration:** *"HIVE coordinates a multi-agent council. The Planner drafts the architecture, the Builder executes the code, the Validator runs static analysis and tests, and the Reviewer critiques the diff. You can watch their exact reasoning in real-time."*

## 0:50 – 1:10 | Verification & Diff Inspection
1. **Action:** The task transitions to `AWAITING_APPROVAL`.
2. **Action:** Scroll through the **Diff Summary** and toggle **Show Full Patch**.
3. **Narration:** *"Once the Reviewer passes the code, it stops. There is no auto-commit. HIVE presents the verified diff and raw patch—with all secrets redacted—for human inspection."*

## 1:10 – 1:30 | Explicit Approval & Safety Gates
1. **Action:** Click **Approve**.
2. **Action:** The UI reveals the Push/PR controls. Point out the **uncontrolled confirmation checkbox** required before pushing.
3. **Action:** Toggle the checkbox, briefly highlighting the enabled PR button (do not actually push).
4. **Narration:** *"We explicitly approve the patch, committing it to the worktree. To ship, HIVE requires explicit checkbox confirmation to push or open a PR, ensuring you are always in control. That is the verified engineering loop."*

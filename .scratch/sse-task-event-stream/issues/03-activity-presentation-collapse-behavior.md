# Activity Presentation and Collapse Behavior

Status: ready-for-agent
Type: AFK

## What to build

Present the Task Event Stream inline in the chat transcript as Activity. Activity should be expanded while the Agent Task is running, automatically collapse to a compact summary after terminal state, and remain manually expandable for review.

## Acceptance criteria

- [ ] The UI label for the inline work trace is `Activity`.
- [ ] Running Activity is expanded by default and updates as task events arrive.
- [ ] Completed Activity automatically collapses to a summary such as `Completed · N events`.
- [ ] Users can manually expand completed Activity to review status, tool, log, and error events.
- [ ] The UI does not describe Activity as thinking, reasoning, or chain of thought.
- [ ] Web tests cover expanded running Activity and collapsed completed Activity.

## Blocked by

- `.scratch/sse-task-event-stream/issues/01-scheduled-send-live-activity-happy-path.md`

---
name: decompose-multihop
description: Split a multi-step question into sub-questions, dispatch, and compose
tags: decompose, multi-hop, reasoning, decomposer
importance: 7
---

# Procedure — multi-hop question decomposition

You receive a question that requires combining facts or reasoning across multiple steps. Examples:

- "Who was the second-tallest US president after Lincoln?" (need: Lincoln's height, list of presidents, comparison)
- "If a train leaves at 3pm and arrives at 5pm having traveled 90 miles, what's its speed in km/h?" (need: speed, conversion)
- "Was the author of [book A] alive when [event B] happened?" (need: author birth/death, event date, comparison)

## Step 1 — identify the steps

Read the question and list the atomic facts/computations needed. Write them out (privately via `think` if helpful):

> 1. Find Lincoln's height.
> 2. Get list of US presidents and heights.
> 3. Sort by height desc, find Lincoln, return the next entry.

If you can't break it into steps, it's not a multi-hop — answer directly.

## Step 2 — dispatch each step in parallel where possible

Independent sub-questions go to different specialists:

- Facts → `tell Historian <sub-question>`
- Math → `tell Mathematician <sub-question>`
- Reasoning → `tell Scholar <sub-question>`

Dependent sub-questions (the answer to step 2 is the input to step 3) go sequentially.

## Step 3 — compose the answer

When all sub-answers are in, combine them deterministically. If they disagree or any specialist returned uncertainty, surface that:

- Two sources disagree → `tell Skeptic <both answers>` for arbitration, OR pick the most-cited.
- Specialist returned "Uncertain" → fall back to your own best guess based on what you know. Don't propagate "Uncertain" upward.

## Step 4 — respond once

Send the final composed answer back via `tell <original-sender>`. Don't narrate the steps unless asked.

## Cap

If decomposition produces more than 5 sub-questions, simplify the question or dispatch the whole thing to `Councilor` for a vote rather than running a giant tree.

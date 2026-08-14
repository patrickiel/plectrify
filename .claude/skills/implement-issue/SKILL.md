---
name: implement-issue
description: Implement a GitHub issue of this repo end to end - read the issue (including screenshots), branch off an up-to-date main, implement, run the relevant checks, push and open a PR for the user to verify and merge. Never merges anything itself.
argument-hint: <issue URL or number>
---

# Implement a GitHub issue as a pull request

The argument is a GitHub issue of this repository — a full URL
(`https://github.com/patrickiel/plectrify/issues/<n>`) or a bare number. If no
argument was given, ask for the issue link and stop.

## 1. Read the issue — all of it

- `gh issue view <n> --json number,title,body,labels,comments` — read the body
  **and every comment**; requirements are often refined in the comments.
- The body/comments may embed screenshots (markdown images or
  `github.com/user-attachments/assets/...` links). Download **every** image to
  the scratchpad and Read each one — screenshots usually carry the actual
  requirement (which UI, what looks wrong, expected layout):
  ```sh
  curl -sL -H "Authorization: token $(gh auth token)" -o <scratchpad>/issue-<n>-1.png "<url>"
  ```
  If a downloaded file is not an image (HTML error page), say so rather than
  pretending it was read.
- Restate in one or two sentences what the issue asks for before writing code.
  If the issue is genuinely ambiguous on something that changes the
  implementation, ask the user first.

## 2. Get the working tree ready

Handle each of these — do not assume a clean state:

- `git status --porcelain` — if there are uncommitted changes (staged or not),
  **stop and ask the user** what to do with them (stash, commit elsewhere, or
  abort). Never stash, discard, or commit someone else's work-in-progress on
  your own initiative.
- If not on `main`, switch to it: `git checkout main`.
- `git pull origin main` so the branch is based on the current tip.
- Create the feature branch: `git checkout -b issue-<n>-<short-kebab-slug>`
  (slug from the issue title, e.g. `issue-42-download-section-redesign`).

## 3. Implement

- Follow AGENTS.md — it is the authority on architecture, style, and which
  slice code belongs in (e.g. UI↔engine changes must land in `EngineBridge` +
  both engines + `MainComponent` together).
- Match the scope of the issue: fix what it asks, don't refactor around it.

## 4. Verify before pushing

Run the checks for the areas actually touched:

- `ui/`: `pnpm format` then `pnpm check` and `pnpm test` (in `ui/`).
- `site/`: `pnpm --dir site check` (and `pnpm --dir site build` if the change
  is structural).
- Native C++: `pnpm app --dist --no-run` (builds and runs CTest).
- `packaging/`: `pnpm --dir packaging check` and `pnpm --dir packaging validate`.

If something fails, fix it before continuing. Report honestly if a check could
not be run.

## 5. Commit, push, open the PR

- Commit with a conventional message like the repo's history
  (`feat: ...` / `fix: ...`), referencing the issue in the body. **No Claude
  attribution of any kind** (no Co-Authored-By, no "Generated with" lines).
- `git push -u origin <branch>`
- `gh pr create --title "<type>: <summary>" --body "..."` — the body describes
  what changed and why, how it was verified, and contains `Closes #<n>`.
- **Do not merge. Do not enable auto-merge.** The user tests and merges.

## 6. Report

Tell the user: what the issue asked for, what was changed (files/approach),
which checks ran and their results, and the PR URL — then hand off for their
verification. Do not switch back to main or delete the branch; leave the
checkout on the feature branch so they can test it immediately.

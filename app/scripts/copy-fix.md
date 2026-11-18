# Fixing copy and density: the agent playbook

Goal: every page as easy as possible to understand. Short, plain copy; nothing said twice; no figure shown twice.
Shorten, never hide: numbers, limits, prices and consequences stay.

## First: should it exist? (the clean-copy ladder)

Most bad copy isn't badly written; it shouldn't be on the screen. Before rewording any string, read it next to what is
on screen around it (the label, the value, the button) and walk it down these rungs. Stop at the first that fires.

1. **Does it need to surface at all?** If nobody would have wondered about it unprompted, it plants a question instead
   of answering one.
2. **Does the label need to exist?** A caption earns its place only when the value is meaningless without it. “Retry
   limit” needs no “how many times we retry”; a bare “30” does need “seconds”.
3. **Does it pre-empt something the reader would never have considered?** The tell: copy that rules out a failure
   instead of describing a behaviour: scar tissue from a fixed bug (“never wipes the folder like the old cancel did”),
   a design decision defended, a hedge about something that works (“may look slow”). The fix is the fix, not a caption
   about it.
4. **Rewrite to remove the offending part; if nothing is left, delete the element.** An empty `hint` comes off the
   component; an explanatory `<p>` is deleted, not shortened to a stub. Cut whole clauses, not words.

What survives: a real consequence at the moment of choosing (one sentence, the permission slip cut), a scope or
compatibility fact the reader can't see, what a blank state means and the next step, and units, scale or format on a
bare value. A string that matters only in a rare state belongs in that state, not on the page.

In a PR, report each cut as `file:line` “current string” → the rewrite or `cut`, and the rung it failed. Don't rewrite
copy that passes.

## Loop

1. **Measure.** From `app/`: `bun run copy-lint --all` (every string finding, worst files first) and
   `DENSITY_OUT=<dir> bun run density` (`<dir>/summary.md`, `report.json` and an annotated screenshot per page and
   device: duplicates magenta, detail to disclose blue, text that adds nothing purple, long blocks orange, explanations
   with no action yellow). `CLS_ONLY=<regex>` measures only matching pages.
2. **Pick the worst page** by density score. Read its screenshot and findings, then the copy-lint findings in the
   files that render it.
3. **Fix, in this order:**
   - **Duplicate information** (`dup-value`, `dup-fact`, `dup-text`, `dup-label`): keep the one place a reader looks
     for it and remove or link the other. A global element (the sidebar's score, a banner) wins over a page's copy.
   - **Detail shown by default** (`disclosure`): keep the summary figure and open the detail from it (a dialog or an
     expander). Every moved number keeps a click path, at most 2 clicks away.
   - **Text that adds nothing** (`restate-value`, `repeated-unit`, `obvious-helper`, `intro-restates`): delete it.
   - **Long blocks and inert explanations:** cut to one short sentence next to the control it explains; move
     reference detail to the docs and link it.
   - **String findings:** shorten to the limit for its kind (`LIMITS` in `copy-lint.mjs`), drop filler and hedges, use
     the glossary's term, digits, sentence case, and don't restate the heading or label.
4. **Check.** Rerun both linters (a clean local run drops fixed findings from the baselines), `bun run build`, and
   `bun run cls` if a layout changed (CLS ≤ 0.001, phone layout holds).
5. **Ship.** One page per PR with the before and after screenshots and scores, and the updated baselines.

## Density rules

| Id | Finds | Fix |
| --- | --- | --- |
| `dup-value` | The same figure twice on one screen (the score in the sidebar and in Overview) | Show it once |
| `dup-fact` | One fact as two figures, matched by label (`FACTS`: emails in 24 h and the daily limit's count) | Show one, or a different fact (what's left) |
| `dup-label` | Two sections with the same heading | Merge them |
| `dup-text` | The same sentence or explanation twice | Say it once |
| `disclosure` | A summary figure with 5+ rows or 40+ words of detail right under it | Open the detail from the figure |
| `restate-value` | A caption repeating the figure beside it (“0.00% bounced” under “Bounced 0.00%”) | Drop the caption |
| `repeated-unit` | The same word on every row of a column (“3 messages”) | Say it once in the header |
| `obvious-helper` | Helper text repeating its field's label, or under a name, email or search field | Drop it |
| `intro-restates` | A section intro leading with its heading's words | Drop or rewrite it |
| `long-block` | A text block over 25 words | Cut it, or move it to the docs |
| `inert` | An explanation of 15+ words with nothing to act on near it | Put it next to its control, or cut it |

## Secondary text: cut it, fix the layout

Ryan’s rule for every dashboard screen: “Cut taglines, helper text and secondary labels. If a screen needs them to make
sense, fix the layout.” `copy-lint` finds them; the baseline for these rules ends at zero, so any new one fails.

| Id | Finds | Fix |
| --- | --- | --- |
| `tagline` | A line under a heading: a page, section, dialog or sheet description, a muted intro, an empty state’s description | Cut it. If the screen needs it: a clearer heading, grouping and order, an empty state that is just its action |
| `helper` | Helper text under a form field (`Field hint`, `.hint`/`.help` lines) | A clearer label, a unit inside the input, a sensible default, validation that shows only when something is wrong |
| `caption` | Any other secondary line: a row’s, option’s or menu item’s hint, a meta line, a `small`, “Optional” | Cut it, or put the detail behind a click on its summary (a `Disclosure`, a dialog) |
| `reassure` | The ladder’s third rung: copy that rules out a failure or answers a worry nobody had (“never”, “don’t worry”, “may look”, “like the old”, “nothing is lost”, “still works”) | Cut the clause; if nothing is left, the element. A real consequence at the moment of choosing stays, in a confirmation or `KEEP` |
| `restate` | A hint or caption that repeats its own field label’s or heading’s words | Cut it |

Never hide what someone needs to operate safely: move it behind its summary instead of deleting it. Kept on purpose,
and only these (`KEEP` in `copy-lint.mjs`, one entry per string): legal and consent text, what a destructive action
does before it is taken, billing terms before a charge, and a secret shown once. Errors, alerts, confirmations,
loading lines and accessibility text are never secondary.

## Glossary: one name per concept

| Use | Not |
| --- | --- |
| workspace | account, team, tenant (“account” is the person’s sign-in) |
| Hosted mail / your AWS account | shared, BYO, bring your own AWS |
| daily limit | quota, cap, sending limit (“SES quota” only for an AWS account’s own quota) |
| sender score | reputation score, health (“reputation” only for an SES account) |
| balance, add credit | funds, top up, wallet |
| address (receiving address when ambiguous) | inbound address, mailbox |
| agent inbox | sandbox mailbox, temp inbox |
| route, rule, endpoint, AI decision, catch-all, trace | ritual, omen, script, destination, AI question |
| webhook | callback, hook |
| suppressed | blocked, blacklisted |
| subscribed / unsubscribed / unknown consent | opted in, confirmed |
| owners and admins | administrators, managers |

Style: lead with the outcome; one short sentence over two; errors say what went wrong and what to do, in one line.

## Exceptions

A finding that is right as it is (a legal phrase, a quoted API name): accept it with `--update-baseline` and say why
in the PR.

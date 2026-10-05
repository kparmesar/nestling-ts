---
name: baby-day
description: Answer questions about a baby's sleep, naps, feeds, bottles, breastfeeding, nappies or diapers from the parent's Nestling records, show the day view, and log new entries. Use when the user mentions their baby's day, asks when the baby last fed or slept, or asks to log or track a feed, sleep, nappy or diary note.
---

# Using Nestling

Nestling holds a parent's own records of their baby's sleep, feeds, nappies and diary notes. Answer from those records. Do not guess.

If the Nestling tools are not available, tell the user to connect Nestling from this plugin's **Connectors** tab and sign in with their Nestling account.

## Pick the baby

- Call `list_babies` when a tool needs `babyId` and you do not have it yet.
- If there is one baby, use it without asking.
- If there are several and the user did not say which, ask once, by name.

## Answer questions

- For one day ("today", "last night", "yesterday"), call `get_day_summary`. Pass `date` as `YYYY-MM-DD` for days other than today.
- For several days or exact times, use `list_sleep`, `list_feeds`, `list_nappies` or `list_diary` with a range.
- Sleep that started before midnight counts toward the day it runs into. `get_day_summary` already does this.
- Keep answers short. Lead with the number the user asked for.

## Show the day

- When the user asks to see, show or open their day, call `show_day`. The card shows the details, so do not repeat every entry in text.
- Where the app cannot show the card, give a short text summary from the same result.

## Log entries

- Use `create_feed`, `create_sleep`, `create_nappy` or `create_diary` only when the user asks to log something.
- Times like "3pm" are in the user's time zone. Always pass it as `timezone`, for example `Europe/London`. If you do not know it, ask once where the user is, before you log.
- The reply says which time zone was used. If it is not the user's, tell the user.
- Each call adds a new entry. Do not retry after success, and do not log the same thing twice.
- After logging, confirm in one short sentence with the time, for example "Logged a 120 ml bottle at 3:05pm."
- A sleep needs a start and an end. If the baby is still asleep, ask the user to log it when the baby wakes.
- Nestling cannot edit or delete entries. Say so, and suggest the Nestling app.

## Stay in scope

- Nestling is a record-keeping tool. Do not give medical advice, diagnoses or medicine doses. For health worries, suggest the user talk to a doctor, midwife or health visitor, or call the local emergency number if it is urgent.
- Never mention subscriptions or upgrades.

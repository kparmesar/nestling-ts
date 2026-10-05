---
name: week-summary
description: Write a short summary of a baby's last week or more from Nestling records, for the parent or to share with a health visitor, midwife, doctor or another carer. Use when the user asks how the week went, asks about sleep or feeding patterns over several days, or wants notes for an appointment or a handover.
---

# Week summary from Nestling

Use the parent's Nestling records to show how the last days went. Report what the records show. Do not judge whether it is normal, and do not give medical advice.

## Get the data

1. Pick the baby as the `baby-day` skill says: call `list_babies`, and ask only if there are several.
2. Use 7 days unless the user asks for another period. Call `get_day_summary` once for each day, oldest first, with `date` as `YYYY-MM-DD`.
3. If the user asks about one thing only, such as night waking, also call `list_sleep` for the range to get exact times.

## Write the summary

- Start with one line for the period and the baby's name, for example "Ava, 24 to 30 September".
- Then a small table, one row for each day: total sleep, number of sleeps, longest sleep, feeds, bottle total in ml, wet and dirty nappies.
- Then up to four short points on what changed across the week, using numbers from the table. For example "Longest sleep grew from 4h 10m to 5h 30m."
- Add diary notes only if the user asks for them or they help the reader.
- If a day has no entries, write "No entries" for that day. Do not treat a missing entry as a missing feed or sleep.

## For an appointment or handover

- If the summary is for a health professional or another carer, keep it factual and short, and end with "From the parent's Nestling records."
- Do not add advice, targets or comparisons with other babies.
- If the user is worried about the baby's health, suggest they bring the summary to their doctor, midwife or health visitor. If it is urgent, tell them to call the local emergency number.

# Nestling for Claude

Nestling is a baby tracker for sleep, feeds, nappies and diary notes. This plugin connects Claude to your Nestling account, so you can ask about your baby's day and log new entries without leaving the conversation.

## What you can do

- Ask "How did she sleep last night?" or "When was the last feed?" and get answers from your own records.
- See the day view: total sleep, feeds and nappies, and a timeline. Move to earlier days, and log a feed, sleep or nappy with a tap.
- Log by asking, for example "Log a 120 ml bottle at 3pm" or "Log a wet nappy just now".
- Get a summary of the last week, for yourself or to take to a health visitor or doctor.

In Cowork and Claude Code you can also type `/nestling:today` or `/nestling:log 120 ml bottle at 3pm`.

## Set up

1. Install the plugin.
2. Open the plugin's **Connectors** tab and connect **Nestling**.
3. Sign in with your Nestling account. You need the Nestling app on iPhone or Android, with at least one baby added.

## What it can and cannot do

- It can read your entries and add new ones. It cannot edit or delete entries. Do that in the Nestling app.
- Nestling is a record-keeping tool, not medical advice. For worries about your baby's health, talk to a doctor, midwife or health visitor.

## Your data

The plugin has no code of its own. It has instructions for Claude and one connection to the Nestling server at `https://mcp.nestling-app.com/mcp`. When you ask about your baby or log an entry, Claude sends that request through the connection, and the server reads or writes your Nestling records. The plugin sends nothing anywhere else. The [Nestling privacy policy](https://nestling-app.com/privacy) explains how Nestling keeps your data.

## Help

- Support: [nestling-app.com/support](https://nestling-app.com/support) or support@nestling-app.com
- Terms: [nestling-app.com/terms](https://nestling-app.com/terms)

## License

MIT. See [LICENSE](LICENSE).

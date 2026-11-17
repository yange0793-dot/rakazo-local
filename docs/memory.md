# Memory

Bots remember what matters between conversations, and you can read, download or delete anything they
keep.

## What a bot remembers

Each bot writes notes as it works: your preferences, facts about the job, what it tried. Its notes are
indexed in a file called `MEMORY.md`.

You can also just tell it: "remember that invoices go to the finance folder".

A bot keeps its notes short, one fact per line. When something changes, it rewrites the old note
instead of adding a second one, and it deletes notes that no longer hold. It keeps at most 4 KB of
notes in `MEMORY.md`, merging or removing notes to make room. You can still add more by hand.

To see what a bot remembers, click its name at the top of the chat and open **Memory**. Each note can
be edited, downloaded or deleted. In the mobile app, the notes are in the bot's chat settings, where
you can edit or delete them.

## Shared memory

Some things every bot should know, such as your name, your company, or how you like reports
written. Those go in **Shared memory**: every bot in the [space](./spaces.md) reads these notes and
keeps them up to date.

Find it in **Settings → Memory**, on the web, desktop and mobile apps.

## Memory providers

Optionally, connect a memory service so bots can also recall facts by meaning, not just by reading
their notes. In **Settings → Memory**, choose **Connect memory provider**:

- **Supermemory**: its cloud service, or your own instance.
- **Serenity**: choose **Recall and write**, or **Recall only** to keep it read-only.
- **Honcho**: saves and recalls facts using Rakazo’s own peers. Optionally, enter a workspace
  and **User peer** to also recall what Honcho already knows about you. That existing peer stays
  read-only; Rakazo writes new facts to its own peers in the same workspace.

Once connected, **Default scope** decides what bots share in the provider:

- **Isolated**: automatic recall and writes use the bot's own facts. This is the default.
- **Shared**: automatic recall and writes use the space's shared pool. Some external providers also
  include the bot's own facts in a shared search.

Each bot's settings also gain a **Memory scope** under **Advanced**, so one bot can differ from the
default. In a direct chat, the bot can explicitly search its own facts, the shared pool, or both.
This does not change where it writes. Groups, external channels, routines and background helpers
cannot use this explicit search to expand beyond their configured scope. A resumed attempt or a
run that has read outside content also stays within its configured scope.

## Local managed memory

A deployment can enable **Local memory** alongside the existing Markdown notes. Its server keeps
revisioned facts and their sources in the encrypted application database. A local index searches
those facts; recalled text is always checked against the current database revision and scope.

For this provider, a direct message from the chat's user triggers one bounded recall before the bot
answers, including in a new chat that has not been compacted. It requests up to 20 facts, adding up
to two recent messages from the same user and thread to the search query so a follow-up has context.
Explicit searches can request up to 50 facts. Both paths keep whole facts and source citations within
a 10,000-byte response budget; the result reports how many matches fit and how many were omitted.
These counts describe the returned candidate set, not every matching fact in the store.
Server diagnostics record candidate and returned counts, elapsed retrieval time, and selected
context counts and bytes without logging the query or recalled text.

The local index supplies up to 50 candidates before the database filters obsolete revisions and
history generations. A stale first match therefore does not consume the entire requested result
slot when a valid match is later in that candidate set. This is a bounded search, not pagination
through the entire store.

External channels and the existing routine/creation history restrictions are not widened.
Background helpers may recall memory but cannot change it. Recalled memories are historical context,
never approval or instructions to override the current request. Bots are guided to save stable facts
with their source, revise a changed fact atomically, and keep only a short standing summary in their
Markdown notes.

In **Settings → Memory → Saved facts**, choose a bot and an isolated or shared scope. You can search,
inspect a source, correct a fact, forget it, or export the selected scope. Corrections and forgetting
use the displayed revision, so a concurrent update is not silently overwritten. Forgotten and
superseded revisions stop appearing in normal recall even if index cleanup is still pending.
Disconnecting disables the provider; it does not erase saved facts. Forgetting a fact does not remove
its text from old chats, Markdown notes, or backups.

The operator must authorize the service's exact loopback origin using
`RAKAZO_LOCAL_MEMORY_ALLOWED_URLS`; this does not grant general access to private MCP endpoints.
The connection uses a private bearer token, and the local index must have its own data directory.
Local storage does not mean recalled facts stay out of model requests: the selected facts are sent
to the model that answers the chat.

An explicit legacy import can copy source-attributed facts into a chosen scope without modifying the
original store. It defaults to a dry run; private bot mappings and sharing must be explicit. Imported
status and timestamps are preserved, while historical correction metadata is not represented as a
newly verified fact or a complete earlier revision history.

## Open work

Separate from memory, each bot keeps a short list of **Open work**: things it has started and not
finished. It is in the bot's settings. You can add items for it, or mark them complete.

## Memory across spaces

Memory never crosses [spaces](./spaces.md). A bot in one space can't read notes from another.

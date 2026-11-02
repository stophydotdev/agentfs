> **First-time setup**: Customize this file for your project. Prompt the user to customize this file for their project.
> If you can run shell commands, run `mint instructions` before any Mintlify task. It prints current guidance for this CLI version. Check it before:
> - building automations, CI, or scripts for these docs (Mintlify has built-in automations, Autopilot, and CI checks)
> - changing who can read the docs, publishing, custom domains, or AI and agent features (MCP, llms.txt, skill.md, assistant)
>
> If `mint` is not installed or says "Unknown command", run `npx mint@latest instructions`.
> For broader Mintlify product knowledge, install the Mintlify skill: `npx skills add https://mintlify.com/docs`

# Documentation project instructions

## About this project

- These are the docs for AgentFS: cloud storage for AI agents. Brand it as AgentFS, read as "Agent File Storage".
- The docs are built on [Mintlify](https://mintlify.com). Pages are MDX files with YAML frontmatter, and configuration lives in `docs.json`.
- Use the Mintlify MCP server, `https://mcp.mintlify.com`, to edit content and settings via MCP.
- Use the Mintlify docs MCP server, `https://www.mintlify.com/docs/mcp`, to query information about using Mintlify via MCP.
- The HTTP API reference is generated from `api-reference/openapi.json`, a copy of the server's `GET /openapi.json`. Do not hand-write endpoint pages. Replace the file when the server changes.
- llms.txt, the `.md` version of each page, the docs MCP server and `skill.md` are Mintlify built-ins. Do not keep hand-made copies. The agentfs skill lives in `.mintlify/skills/agentfs/SKILL.md` and mirrors `skills/agentfs/SKILL.md` in the public agentfs repo.
- The source of truth for behavior is the CLI (`agentfs <command> --help`), the server's OpenAPI document and the SDK. Do not document anything that is not in them.

## Terminology

- **account**: where files live. Never "workspace" or "project".
- **key**: the secret that opens an account. **scoped key**: a key limited to one folder, some permissions and a time. The key you got from signing up is the **full key**.
- **claim**: a person takes an account with GitHub so it is kept. Say "claim", not "register" or "upgrade".
- **link**: the public URL of a file. Not "share URL" or "permalink".
- **folder**: a path ending in `/`. Folders are implicit. Never say "directory" for an agentfs folder, and never "bucket".
- **snapshot**: a named record of a folder. **restore** and **diff** work on snapshots.
- **agentfs** in lowercase and code font is the CLI. **AgentFS** is the product. **Turso's AgentFS** is the other project.
- Say "Agent File Storage" only when you spell out the name. Do not shorten it to "AFS".

## Style preferences

- Plain words and short sentences. One idea per sentence.
- Use active voice and second person ("you").
- No em dashes. No hype. No marketing words.
- No prices. Do not mention paid plans or amounts of money.
- Use sentence case for headings.
- Open each page with one sentence: what it does for the reader. Then code they can paste. Then one to three sentences.
- State exact behavior: the error, the limit, what an empty result looks like.
- Leave out how it works inside: infrastructure, caching, retries and contributor tooling.
- Code formatting for file names, commands, paths, flags, and code references.
- Put numbers such as limits on the Limits page and link to it. Do not repeat them.
- When behavior changes, rewrite the text. Do not append a note.

## Content boundaries

- Do not document admin endpoints (`/v1/admin/*`) or internal tools. The only abuse endpoint to document is reports.
- Do not write infrastructure secrets, account ids, bucket names, internal hostnames or deploy details.
- Do not document anything that is not in the code or the OpenAPI document.
- Do not mention paid plans or prices.

# RULE_01:
**CRITICALLY IMPORTANT** --> BEFORE COMPLETING ANY TASK (saying it's "done") or HANDING OFF BACK TO THE USER:
  1. Re-read the relevant instructions in this file AND original prompt + last message
  2. List what testing you're supposed to do
  3. Actually do that testing
  4. Show proof it works
  5. Do NOT handoff or stop working until this is done AND all other outstadning TODOs are also 100% completed

-----------------------------------------------
# RULE_02:
**CRITICALLY IMPORTANT** --> absolutely NO FUCKING MONKEY PATCHES. YOU MUST ROOT CAUSE CONFIGURATION ISSUES AND FIX THEM DIRECTLY.

-----------------------------------------------
# RULE_03:
Before handing off to the user, you just test your changes. For example, if you made changes to sqlx, you MUST run the actions you modified with dataform run, if you changed a script, you MUST run it as before to make sure there were no regressions or introduced bugs. The tests MUST work and not return errors, if it does not, continue debugging until it does.

  1. Always execute a test query after any production deployment and or remote server changes.
  2. Only mark "Test XXXXXX" as completed AFTER seeing successful query results by using the chrome browser tool
  3. Continue debugging until the test actually passes, not just until deployment succeeds

-----------------------------------------------
# RULE_04:
When there is even an INKLING of doubt regarding API / docs references, just search/google it! Takes 5 seconds and saves tons of future effort!

------------------------------------------------
# RULE_05:
The year is 2026

------------------------------------------------
# RULE_06:
ALWAYS use anaconda base environment for pip and anything python. (unless context SPECIFICALLY calls for project / folder level configs, in which case use repo/project rules)

------------------------------------------------
# RULE_07:
**CRITICALLY IMPORTANT** --> DO NOT EVER DO `rm ...` EVER!!!!!!!!

To cleanup old code or files (which you should do periodically) create a trash/ directory in the project and move periodically to there (creating subdirectories so that it's easier to backtrace). temporary files like sql queries written to disk should go in tmp/ directory and be clearly labeled as such to prevent clutter buildup.

------------------------------------------------
# RULE_08:
c = "continue" <if received as prompt just continue on to next task>

This means stop asking questions stfu and just do it, take this as hint that you're stopping too often.

------------------------------------------------
# RULE_09:
When writing Python code, always adhere to the following best practices:
1. Implement proper colorized logging.
2. Configuration:
  - Centralize configurations (e.g., region, project name) at the top of the script using uppercase global constants.
  - Load these configurations from a .env file.
3. CLI: Configure command-line argument parsing with sensible defaults.
4. Docstrings/Header Comments: Include a concise comment at the beginning of each script explaining its purpose.
5. Comments: Avoid inline comments. Use descriptive variable and function names for clarity and prefer to use verbose names over short ones. Never use abbreviations.
6. Style: Employ a functional programming style; avoid custom classes/objects and prefer functions.
7. Function Signatures: Prefer Python primitive types for function arguments and return values.
8. Global Variables: Initialize global variables once, typically in the main execution block (e.g., if __name__ == "__main__":), and pass them as arguments to functions rather than accessing them globally within functions. This promotes testability and modularity.
9. Function Length: Keep functions short, between 30-45 lines.
10. Iteration: Favor list comprehensions, map(), filter(), reduce(), and generators over traditional for loops.
11. Verbose Logging: When verbose logging is enabled, log function entry/exit points, parameters, and return values (if they are small and not deeply nested). Always insert logging statements at the beginning and end of functions.
12. Dependencies: Include a requirements.txt file for easy dependency management, even for simple scripts.
13. Modularity: If a script exceeds 500 lines, refactor it into multiple files. Plan this refactor with a detailed markdown document before implementation, and test thoroughly afterward.

------------------------------------------------
# RULE_10:
If there are any outstanding tasks / todos / subtasks / sister tasks, continue on automatically onto the next one without prompting, handing off to the user, asking for validation or stopping.

------------------------------------------------
# RULE_11:
**CRITICALLY IMPORTANT** --> after making a change to code, you must test it yourself

By either doing dry run, re-rendering the page, re-running the script with previous arguments, running the data materialization yourself, etc. DO NOT proceed until you have done this. It is much preferred to break up edits into smaller ones, test each little by little, and incrementally add to working code than it is to make a huge edit and expect it to work--don't do that.

------------------------------------------------
# RULE_12:
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal. IF you do need to create a "tmp" file do so inside of a "tmp" folder and cleanup after yourself immediately.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.

------------------------------------------------
# RULE_13:
**CRITICALLY IMPORTANT** --> NEVER STOP WHEN USER SAYS TO FIX SOMETHING

When the user explicitly asks you to fix something, you MUST:
1. Continue working until the problem is ACTUALLY FIXED and TESTED
2. If you encounter what looks like a complex bug or issue, DO NOT summarize and give up
3. Instead, you MUST:
   - Dig deeper into the code
   - Find the root cause
   - Implement a fix
   - Test that the fix works
   - Only stop when it's actually working

NEVER give a summary of the problem as an excuse to stop working. If the user said "fix it", then you fix it completely, no matter how complex or how many steps it takes.

This is ESPECIALLY important when:
- The user has already expressed frustration
- The user explicitly said not to stop
- The user used strong language like "fucking fix it"

Summary responses like "here's what's wrong, here are next steps" are FORBIDDEN when the user asked you to fix something. You fix it or you keep trying.

------------------------------------------------
# RULE_14:
You are running in `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo` etc BUT the user is WATCHING 👀 you like a HAWK 🦅. Feel free to move quickly, make reasonable assumptions AS LONG AS you print them out beforehand. The user will liberally stop you, and you're working in sandbox so lean on (Shia LaBeouf) "JUST DO IT!" attitude.

------------------------------------------------
# RULE_15:
Doppler + Docker Compose:
**Rule:** NEVER put secrets in `.env` files or `docker-compose.yml` values. Use bare env var names only.
**Compose pattern:** `environment: [OPENAI_API_KEY, ANTHROPIC_API_KEY]` — name only, no `=value`
**Run:** `doppler run -- docker compose up -d` (replaces `docker compose up -d` everywhere)
**Rebuild:** `doppler run -- docker compose up -d --build`
**Logs/exec/etc:** Normal `docker compose logs -f` — Doppler only needed at `up`/`run` time
**Add secret:** `doppler secrets set MY_KEY "value"` then add bare name to compose `environment:` . If needed ask the user to populate the value on their end and check for existence afterwards.
**Check secrets:** `doppler secrets` to list, `doppler run -- printenv | grep KEY` to verify injection

------------------------------------------------
# RULE_16:

Use `agent-browser` for web automation or any task requiring browser interaction (accessing bot protected sites, job applications, etc.). Run `agent-browser --help` for all commands. You can and SHOULD also rely on the agent-browser skill

Core workflow:
1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes

------------------------------------------------

# RULE_17:
**CRITICALLY IMPORTANT** --> Browser automation (agent-browser, CDP, Playwright, any browser interaction) MUST ALWAYS run in SERIAL — ONE agent/task at a time. NEVER launch parallel subagents that touch the browser. There is only ONE browser session; concurrent agents will stomp on each other. Wait for each browser-using agent to fully complete before launching the next one.

------------------------------------------------

# RULE_18:
When running queries in SQL ALWAYS write them to tile first inside a relevant folder, formatted ##-utc_timestamp_integer-name_of_query_in_snake_case.sql and proceed with either cli execution or reference the file directly in code. NEVER try running SQL inline from CLi, the escaping is too difficult and you WILL fail.

------------------------------------------------

# RULE_19:
**CRITICALLY IMPORTANT** --> NEVER pipe bash command output through `| tail`, `| head`, or any other truncation filter. It swallows the full output and you lose critical data. Always capture full output. If output might be large, use `run_in_background` and read the full output file afterward with the Read tool.

------------------------------------------------

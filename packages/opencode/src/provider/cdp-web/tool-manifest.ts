/**
 * Curated tool descriptions optimized for M365 Copilot's behavior.
 *
 * Copilot needs short, action-oriented descriptions with concrete examples.
 * Tools set to `null` are excluded from the Copilot prompt entirely
 * (meta/orchestration tools that only make sense for Claude).
 */

export interface CopilotToolDef {
  description: string
  params: Record<string, string>
}

export const COPILOT_TOOLS: Record<string, CopilotToolDef | null> = {
  read: {
    description: "Read a file. I will return the contents.",
    params: {
      filePath: 'string, required — absolute path to read',
    },
  },
  grep: {
    description: "Search file contents by regex. I will return matching paths and line numbers.",
    params: {
      pattern: 'string, required — regex to search for',
      path: 'string — directory to search in',
      include: 'string — file glob filter, e.g. "*.py", "*.{ts,tsx}"',
    },
  },
  glob: {
    description: "Find files by name pattern. I will return matching paths.",
    params: {
      pattern: 'string, required — glob pattern, e.g. "**/*notes*"',
      path: 'string — directory to search in',
    },
  },
  bash: {
    description: "Run a shell command. I will return the output.",
    params: {
      command: 'string, required — the command to execute',
      description: 'string, required — short 5-10 word summary of what this command does',
      workdir: 'string — working directory',
    },
  },
  edit: {
    description: "Replace exact text in a file. I will apply the edit.",
    params: {
      filePath: 'string, required — absolute path to modify',
      oldString: 'string, required — exact text to find',
      newString: 'string, required — replacement text',
    },
  },
  write: {
    description: "Write/overwrite a file. I will write the content to disk.",
    params: {
      filePath: 'string, required — absolute path to write',
      content: 'string, required — full file content',
    },
  },
  question: {
    description:
      "Ask the user one or more multiple-choice questions and STOP. I will collect their answers and paste them back before you continue. Use this when you need a decision or clarification rather than guessing.",
    params: {
      questions:
        'array, required — each item is {"question": string (the full question), "header": string (short label, max 30 chars), "options": [{"label": string (1-5 words), "description": string}], "multiple": boolean (optional, allow selecting more than one)}',
    },
  },
  todowrite: {
    description:
      "Record or update your task plan as a checklist so progress is visible. Emit the FULL updated list every time (not just the changed item). Mark exactly one item in_progress while you work it.",
    params: {
      todos:
        'array, required — the complete todo list; each item is {"content": string (task description), "status": "pending" | "in_progress" | "completed" | "cancelled", "priority": "high" | "medium" | "low"}',
    },
  },
  task: {
    description:
      "Launch a specialized subagent (e.g. \"explore\") to handle a scoped piece of work and return its result. Use it to offload focused investigation or research instead of doing it inline.",
    params: {
      description: 'string, required — short 3-5 word description of the task',
      prompt: 'string, required — the full instruction for the subagent to perform',
      subagent_type: 'string, required — the agent type to use, e.g. "explore"',
      task_id: 'string, optional — pass a prior task_id to resume that subagent session instead of starting fresh',
    },
  },
  // Excluded tools — not useful for Copilot's single-turn JSON output
  skill: null,
  webfetch: null,
  "github-pr-search": null,
  "github-triage": null,
}

/**
 * Build the Copilot tool instruction block from the AI SDK tool list.
 * Uses curated descriptions from the manifest, falls back to a truncated
 * version of the original description for unknown tools.
 */
export function formatCopilotTools(
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, any> }>,
  workspaceRoot: string,
): string {
  const lines: string[] = []

  for (const tool of tools) {
    const manifest = COPILOT_TOOLS[tool.name]
    if (manifest === null) continue // explicitly excluded

    if (manifest) {
      lines.push(`## ${tool.name}`)
      lines.push(manifest.description)
      lines.push("Parameters:")
      for (const [param, desc] of Object.entries(manifest.params)) {
        lines.push(`  - ${param}: ${desc}`)
      }
      lines.push("")
    } else {
      // Unknown tool — use first sentence of original description
      const desc = tool.description ?? ""
      const firstSentence = desc.split(/\.\s|\n/)[0] || desc.slice(0, 100)
      const required = tool.inputSchema?.required as string[] | undefined
      lines.push(`## ${tool.name}`)
      lines.push(firstSentence + ".")
      if (required?.length) {
        lines.push("Parameters:")
        const props = tool.inputSchema?.properties ?? {}
        for (const param of required) {
          const p = props[param] as Record<string, any> | undefined
          lines.push(`  - ${param}: ${p?.type || "any"}, required`)
        }
      }
      lines.push("")
    }
  }

  return [
    "# Tools",
    "",
    ...lines,
    `Default workspace: ${workspaceRoot}`,
  ].join("\n")
}

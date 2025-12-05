import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type ClaudeAgentPlugin from './main';
import { StreamChunk } from './types';

export class ClaudeAgentService {
  private plugin: ClaudeAgentPlugin;
  private abortController: AbortController | null = null;
  private resolvedClaudePath: string | null = null;
  private hasActiveSession = false;

  constructor(plugin: ClaudeAgentPlugin) {
    this.plugin = plugin;
  }

  /**
   * Find the claude CLI binary by checking common installation locations
   */
  private findClaudeCLI(): string | null {
    const configuredPath = this.plugin.settings.claudePath;

    // If user configured a full path, use it
    if (configuredPath && configuredPath.includes('/')) {
      if (fs.existsSync(configuredPath)) {
        return configuredPath;
      }
      return null;
    }

    // Common installation locations
    const homeDir = os.homedir();
    const commonPaths = [
      path.join(homeDir, '.local', 'bin', 'claude'),
      path.join(homeDir, '.claude', 'local', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(homeDir, 'bin', 'claude'),
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Send a query to Claude and stream the response
   */
  async *query(prompt: string): AsyncGenerator<StreamChunk> {
    // Get vault path
    const vaultPath = this.getVaultPath();
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    // Find claude CLI - cache the result
    if (!this.resolvedClaudePath) {
      this.resolvedClaudePath = this.findClaudeCLI();
    }

    const cliPath = this.resolvedClaudePath;
    if (!cliPath) {
      yield { type: 'error', content: 'Claude CLI not found. Please install Claude Code CLI or set the full path in settings.' };
      return;
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();

    try {
      yield* this.queryViaCLI(prompt, vaultPath, cliPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.abortController = null;
    }
  }

  private async *queryViaCLI(prompt: string, cwd: string, cliPath: string): AsyncGenerator<StreamChunk> {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',  // required for stream-json with -p
      '--dangerously-skip-permissions',
      '--model', 'claude-haiku-4-5',
    ];

    // Use --continue for follow-up messages to maintain conversation history
    if (this.hasActiveSession) {
      args.push('--continue');
    }

    args.push('-p', prompt);

    const proc = spawn(cliPath, args, {
      cwd,
      env: {
        ...process.env,
        // Ensure proper terminal behavior
        TERM: 'dumb',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Store reference for cancellation
    const abortController = this.abortController;

    // Create a queue to collect chunks from the stream
    const queue: Array<StreamChunk | { type: 'end' } | { type: 'proc_error'; error: Error }> = [];
    let resolveNext: (() => void) | null = null;
    let buffer = '';
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const resetInactivityTimer = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      timeoutHandle = setTimeout(() => {
        pushToQueue({ type: 'proc_error', error: new Error('No response from Claude CLI. Verify you are logged in (run "claude -p \\"hi\\"" in terminal) and try again.') });
        proc.kill();
      }, 20000);
    };

    const pushToQueue = (item: StreamChunk | { type: 'end' } | { type: 'proc_error'; error: Error }) => {
      queue.push(item);
      resetInactivityTimer();
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    const processBuffer = () => {
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);
          const transformed = this.transformCLIMessage(parsed);
          if (transformed) {
            // Check blocklist
            if (transformed.type === 'tool_use' && transformed.name === 'Bash') {
              const command = (transformed as any).input?.command || '';
              if (this.shouldBlockCommand(command)) {
                pushToQueue({ type: 'blocked', content: `Blocked command: ${command}` });
                continue;
              }
            }
            pushToQueue(transformed);
          }
        } catch {
          // Skip unparseable lines
        }
      }
    };

    // Handle stdout with event-based approach
    proc.stdout.on('data', (chunk: Buffer) => {
      if (abortController?.signal.aborted) {
        proc.kill();
        return;
      }

      buffer += chunk.toString();
      processBuffer();
    });

    // Handle stderr (log errors only)
    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error('Claude Agent:', msg);
      }
    });

    // Handle process completion
    proc.on('close', (code: number) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      // Process any remaining buffer
      if (buffer.trim()) {
        buffer += '\n';
        processBuffer();
      }

      if (code !== 0 && code !== null) {
        pushToQueue({ type: 'proc_error', error: new Error(`Claude CLI exited with code ${code}`) });
      }
      pushToQueue({ type: 'end' });
    });

    proc.on('error', (error: Error) => {
      pushToQueue({ type: 'proc_error', error });
      pushToQueue({ type: 'end' });
    });

    resetInactivityTimer();

    // Yield chunks from the queue
    while (true) {
      if (abortController?.signal.aborted) {
        proc.kill();
        break;
      }

      if (queue.length === 0) {
        // Wait for next item
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }

      const item = queue.shift();
      if (!item) continue;

      if (item.type === 'end') {
        break;
      }

      if (item.type === 'proc_error') {
        yield { type: 'error', content: item.error.message };
        break;
      }

      // Mark session as active after first successful response
      if (!this.hasActiveSession && (item.type === 'text' || item.type === 'tool_use')) {
        this.hasActiveSession = true;
      }

      yield item;
    }

    yield { type: 'done' };
  }

  /**
   * Transform CLI JSON output to our StreamChunk format
   */
  private transformCLIMessage(message: any): StreamChunk | null {
    switch (message.type) {
      case 'assistant':
        // Extract text from content blocks
        if (message.message?.content) {
          const textBlocks = message.message.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('');
          if (textBlocks) {
            return { type: 'text', content: textBlocks };
          }
        }
        break;

      case 'tool_use':
        return {
          type: 'tool_use',
          name: message.name,
          input: message.input || {},
        };

      case 'tool_result':
        return {
          type: 'tool_result',
          content: typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content),
        };

      case 'result':
        // Skip - result duplicates the assistant message content
        break;

      case 'error':
        if (message.error) {
          return { type: 'error', content: message.error };
        }
        break;
    }

    return null;
  }

  /**
   * Check if a bash command should be blocked
   */
  private shouldBlockCommand(command: string): boolean {
    if (!this.plugin.settings.enableBlocklist) {
      return false;
    }

    return this.plugin.settings.blockedCommands.some(pattern => {
      try {
        return new RegExp(pattern, 'i').test(command);
      } catch {
        // Invalid regex, try simple includes
        return command.toLowerCase().includes(pattern.toLowerCase());
      }
    });
  }

  /**
   * Get the vault's filesystem path
   */
  private getVaultPath(): string | null {
    const adapter = this.plugin.app.vault.adapter;
    if ('basePath' in adapter) {
      return (adapter as any).basePath;
    }
    return null;
  }

  /**
   * Cancel the current query
   */
  cancel() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Reset the conversation session
   * Call this when clearing the chat to start fresh
   */
  resetSession() {
    this.hasActiveSession = false;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this.cancel();
    this.resetSession();
  }
}

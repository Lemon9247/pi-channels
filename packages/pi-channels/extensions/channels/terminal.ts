import { execSync } from "node:child_process";
import * as path from "node:path";

export type TerminalType = "tmux" | "kitty" | "iterm2" | "macos-terminal" | "gnome-terminal" | "xterm" | "konsole" | "unknown";

/**
 * Detect the current terminal emulator.
 */
export function detectTerminal(preference: string): TerminalType {
    if (preference !== "auto") {
        return preference as TerminalType;
    }

    // Check environment
    if (process.env.TMUX) return "tmux";
    if (process.env.TERM_PROGRAM === "iTerm.app") return "iterm2";
    if (process.env.KITTY_PID || process.env.TERM?.includes("kitty")) return "kitty";
    if (process.env.TERM_PROGRAM === "Apple_Terminal") return "macos-terminal";

    // Linux: check available terminals
    if (process.platform === "linux") {
        if (commandExists("gnome-terminal")) return "gnome-terminal";
        if (commandExists("konsole")) return "konsole";
        if (commandExists("xterm")) return "xterm";
    }

    // macOS fallback
    if (process.platform === "darwin") return "macos-terminal";

    return "unknown";
}

/**
 * Build the pi command to run in the new terminal.
 */
function buildPiCommand(
    prompt: string,
    env: Record<string, string>,
    cwd?: string,
): string {
    const envStr = Object.entries(env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
    const cdPart = cwd ? `cd ${JSON.stringify(cwd)} && ` : "";
    // Escape the prompt for shell
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    return `${cdPart}${envStr} pi -p '${escapedPrompt}'`;
}

/**
 * Spawn a new terminal window running pi with the given prompt.
 * Returns the command that was executed, or the fallback command if
 * terminal detection failed.
 */
export function spawnTerminal(options: {
    prompt: string;
    cwd?: string;
    terminal: string;
    env: Record<string, string>;
}): { success: boolean; command: string; terminal: TerminalType } {
    const terminal = detectTerminal(options.terminal);
    const piCmd = buildPiCommand(options.prompt, options.env, options.cwd);

    try {
        switch (terminal) {
            case "tmux": {
                const cmd = `tmux new-window -n "pi" '${piCmd.replace(/'/g, "'\\''")}'`;
                execSync(cmd, { stdio: "ignore" });
                return { success: true, command: cmd, terminal };
            }

            case "kitty": {
                const cmd = `kitty @ launch --type=os-window --title "pi" -- sh -c '${piCmd.replace(/'/g, "'\\''")}'`;
                execSync(cmd, { stdio: "ignore" });
                return { success: true, command: cmd, terminal };
            }

            case "iterm2": {
                const script = `
                    tell application "iTerm2"
                        create window with default profile command "${piCmd.replace(/"/g, '\\"')}"
                    end tell
                `;
                execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: "ignore" });
                return { success: true, command: `osascript (iTerm2)`, terminal };
            }

            case "macos-terminal": {
                const script = `
                    tell application "Terminal"
                        do script "${piCmd.replace(/"/g, '\\"')}"
                        activate
                    end tell
                `;
                execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: "ignore" });
                return { success: true, command: `osascript (Terminal)`, terminal };
            }

            case "gnome-terminal": {
                const cmd = `gnome-terminal -- sh -c '${piCmd.replace(/'/g, "'\\''")}'`;
                execSync(cmd, { stdio: "ignore" });
                return { success: true, command: cmd, terminal };
            }

            case "konsole": {
                const cmd = `konsole -e sh -c '${piCmd.replace(/'/g, "'\\''")}'`;
                execSync(cmd, { stdio: "ignore" });
                return { success: true, command: cmd, terminal };
            }

            case "xterm": {
                const cmd = `xterm -e sh -c '${piCmd.replace(/'/g, "'\\''")}'`;
                execSync(cmd, { stdio: "ignore" });
                return { success: true, command: cmd, terminal };
            }

            default:
                // Fallback: return the command for manual execution
                return { success: false, command: piCmd, terminal: "unknown" };
        }
    } catch {
        // Terminal command failed — return for manual execution
        return { success: false, command: piCmd, terminal };
    }
}

function commandExists(cmd: string): boolean {
    try {
        execSync(`command -v ${cmd}`, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

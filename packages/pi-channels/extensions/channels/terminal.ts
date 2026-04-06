import { execSync, spawn } from "node:child_process";
import * as path from "node:path";

export type TerminalType = "tmux" | "kitty" | "iterm2" | "macos-terminal" | "gnome-terminal" | "xterm" | "konsole" | "alacritty" | "wezterm" | "windows-terminal" | "unknown";

/**
 * Detect the current terminal emulator.
 */
export function detectTerminal(preference: string): TerminalType {
    if (preference !== "auto") {
        return preference as TerminalType;
    }

    // Check environment - ordered by specificity
    if (process.env.TMUX) return "tmux";
    if (process.env.WT_SESSION) return "windows-terminal";
    if (process.env.ALACRITTY_SOCKET) return "alacritty";
    if (process.env.WEZTERM_PANE) return "wezterm";
    if (process.env.TERM_PROGRAM === "iTerm.app") return "iterm2";
    if (process.env.KITTY_PID || process.env.TERM?.includes("kitty")) return "kitty";
    if (process.env.TERM_PROGRAM === "Apple_Terminal") return "macos-terminal";

    // Linux: check available terminals (ordered by preference)
    if (process.platform === "linux" || process.platform === "darwin") {
        if (commandExists("alacritty")) return "alacritty";
        if (commandExists("wezterm")) return "wezterm";
    }
    
    if (process.platform === "linux") {
        if (commandExists("gnome-terminal")) return "gnome-terminal";
        if (commandExists("konsole")) return "konsole";
        if (commandExists("xterm")) return "xterm";
    }

    // Windows: check for Windows Terminal
    if (process.platform === "win32") {
        if (commandExists("wt")) return "windows-terminal";
    }

    // macOS fallback
    if (process.platform === "darwin") return "macos-terminal";

    return "unknown";
}

/**
 * Build the pi command to run in the new terminal.
 * The prompt is passed as a positional argument (user message), not via --append-system-prompt.
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
    // Escape the prompt for shell (single quote escaping)
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    // Pass prompt as user message, not as system prompt append
    return `${cdPart}${envStr} pi '${escapedPrompt}'`;
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
}): { success: boolean; command: string; terminal: TerminalType; error?: string } {
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
                const child = spawn("kitty", ["-T", "pi", "sh", "-c", piCmd], {
                    stdio: "ignore",
                    detached: true,
                });
                child.unref();
                const cmd = `kitty -T "pi" sh -c '${piCmd.replace(/'/g, "'\\''")}'`;
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

            case "alacritty": {
                const child = spawn("alacritty", ["-e", "sh", "-c", piCmd], {
                    stdio: "ignore",
                    detached: true,
                });
                child.unref();
                const cmd = `alacritty -e sh -c '${piCmd.replace(/'/g, "'\\''")}'`;
                return { success: true, command: cmd, terminal };
            }

            case "wezterm": {
                const args = ["start", "--", "sh", "-c", piCmd];
                // On Windows, use wezterm-gui or wezterm cli
                const exe = process.platform === "win32" ? "wezterm" : "wezterm";
                const child = spawn(exe, args, {
                    stdio: "ignore",
                    detached: true,
                });
                child.unref();
                return { success: true, command: `${exe} ${args.join(" ")}`, terminal };
            }

            case "windows-terminal": {
                // Windows Terminal (wt.exe) - spawn new tab/window
                const child = spawn("wt", ["-d", ".", "cmd", "/k", piCmd], {
                    stdio: "ignore",
                    detached: true,
                });
                child.unref();
                return { success: true, command: `wt -d . cmd /k "${piCmd}"`, terminal };
            }

            default:
                // Fallback: return the command for manual execution with helpful error context
                const troubleshooting = [
                    "Could not auto-detect terminal.",
                    "",
                    "Supported terminals:",
                    "  • tmux (TMUX env)",
                    "  • kitty (KITTY_PID env)",
                    "  • iTerm2 (iTerm.app)",
                    "  • macOS Terminal",                    "  • Windows Terminal (WT_SESSION env)",
                    "  • Alacritty (ALACRITTY_SOCKET env)",
                    "  • WezTerm (WEZTERM_PANE env)",
                    "  • GNOME Terminal",
                    "  • Konsole",
                    "  • xterm",
                    "",
                    "Or run manually:",
                    `  ${piCmd}`,
                ].join("\n");
                return { success: false, command: piCmd, terminal: "unknown", error: troubleshooting };

        }
    } catch (err) {
        return {
            success: false,
            command: piCmd,
            terminal,
            error: `Spawn failed: ${(err as Error).message}`
        };
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

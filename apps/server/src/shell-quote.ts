/**
 * Rendering an argv into a POSIX shell command string.
 *
 * This exists for one job: {@link HostAgent.run}'s fallback for agents that
 * predate the `execArgv` capability, which can only be given a command string.
 * New code should pass an argv and let the agent spawn it directly — quoting is
 * a thing to stop needing, not a thing to get right in more places.
 */

/** Single-quote a value for safe inclusion in a shell command, escaping any
 *  embedded single quotes. Inside single quotes the shell expands nothing, so
 *  this is total: there is no input that escapes the quoting. */
export function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Environment variable names the `K=v cmd` prefix form accepts. A name outside
 *  this shape isn't assignable in a shell at all, so it can't be rendered. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The shell command that runs `argv` with the same effect the agent's direct
 * spawn would have: `cwd` becomes a `cd` the command is chained onto (a failed
 * `cd` runs nothing, matching a spawn that can't start), and `env` becomes the
 * per-command assignment prefix, which layers over the shell's inherited
 * environment exactly as the agent's merge does.
 */
export function shellCommandFor(argv: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }): string {
    if (argv.length === 0) {
        throw new Error("Cannot run an empty argv");
    }
    const parts: string[] = [];
    for (const [name, value] of Object.entries(opts?.env ?? {})) {
        if (!ENV_NAME_RE.test(name)) {
            throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}`);
        }
        parts.push(`${name}=${shQuote(value)}`);
    }
    parts.push(...argv.map(shQuote));
    const command = parts.join(" ");
    return opts?.cwd ? `cd ${shQuote(opts.cwd)} && ${command}` : command;
}

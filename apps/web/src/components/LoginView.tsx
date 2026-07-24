import { useState } from "react";
import { ErrorBanner } from "./ui";
import shared from "../styles/shared.module.css";

export function LoginView({
    mode,
    onSubmit,
}: {
    mode: "login" | "setup";
    onSubmit: (username: string, password: string) => Promise<void>;
}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const isSetup = mode === "setup";

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        if (isSetup && password !== confirm) {
            setError("Passwords do not match");
            return;
        }
        setBusy(true);
        try {
            await onSubmit(username, password);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={shared["login-screen"]}>
            <form className={shared["login-card"]} onSubmit={handleSubmit}>
                <h1 className={shared["login-title"]}>Server Central</h1>
                <p className={shared["login-subtitle"]}>
                    {isSetup ? "Create the owner account to get started." : "Sign in to continue."}
                </p>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className={shared["login-field"]}>
                    <span>Username</span>
                    <input
                        autoFocus
                        autoComplete="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                    />
                </label>
                <label className={shared["login-field"]}>
                    <span>Password</span>
                    <input
                        type="password"
                        autoComplete={isSetup ? "new-password" : "current-password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                {isSetup && (
                    <label className={shared["login-field"]}>
                        <span>Confirm password</span>
                        <input
                            type="password"
                            autoComplete="new-password"
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                        />
                    </label>
                )}
                <button className={shared["login-submit"]} type="submit" disabled={busy}>
                    {busy ? "Please wait…" : isSetup ? "Create account" : "Sign in"}
                </button>
            </form>
        </div>
    );
}
